import * as Bigtable from "@google-cloud/bigtable";
import * as Debug from "debug";
import * as murmur from "murmurhash";

import { BigtableClientConfig, RuleColumnFamily } from "./interfaces";
import { JobTTLEvent } from "./JobTTLEvent";
import { EventEmitter } from "events";

const debug = Debug("yildiz:bigtable:client");

const DEFAULT_TTL_SCAN_INTERVAL_MS = 5000;
const DEFAULT_MIN_JITTER_MS = 2000;
const DEFAULT_MAX_JITTER_MS = 30000;
const DEFAULT_MAX_VERSIONS = 1;

const DEFAULT_CLUSTER_COUNT = 3;
const DEFAULT_MURMUR_SEED = 1;

const DEFAULT_COLUMN = "value";
const DEFAULT_COLUMN_FAMILY = "default";
const COUNTS = "counts";

export class BigtableClient extends EventEmitter {

  private config: BigtableClientConfig;
  private instance: Bigtable.Instance;
  private table!: Bigtable.Table;
  private cfName!: string;
  private tov!: NodeJS.Timer;

  public tableMetadata!: Bigtable.Table;
  public cfNameMetadata!: string;
  public clusterCount: number;

  private job: JobTTLEvent;
  private defaultColumn!: string;
  private intervalInMs: number;
  private minJitterMs: number;
  private maxJitterMs: number;
  private isInitialized: boolean;
  private murmurSeed: number;

  constructor(
    config: BigtableClientConfig,
    instance: Bigtable.Instance,
    intervalInMs: number,
    minJitterMs: number,
    maxJitterMs: number,
    clusterCount?: number,
    murmurSeed?: number,
  ) {
    super();

    this.instance = instance;
    this.intervalInMs = intervalInMs || DEFAULT_TTL_SCAN_INTERVAL_MS;
    this.minJitterMs = minJitterMs || DEFAULT_MIN_JITTER_MS;
    this.maxJitterMs = maxJitterMs || DEFAULT_MAX_JITTER_MS;
    this.clusterCount = clusterCount || DEFAULT_CLUSTER_COUNT;
    this.murmurSeed = murmurSeed || DEFAULT_MURMUR_SEED;
    this.config = config;
    this.isInitialized = false;
    this.job = new JobTTLEvent(this, this.intervalInMs);
  }

  /**
   * Helper function to generate ttlRowKey
   * @param rowKey
   * @param data
   */
  private getTTLRowKey(ttl: number) {

    const deleteTimestamp = Date.now() + (1000 * ttl);
    const salt = murmur.v3(deleteTimestamp.toString(), this.murmurSeed) % this.clusterCount;

    return `ttl#${salt}#${deleteTimestamp}`;
  }

  /**
   * Generic insert for both row and cell
   * @param rowKey
   * @param data
   */
  private async insert(
    table: Bigtable.Table,
    cfName: string,
    rowKey: string,
    data: Bigtable.GenericObject,
  ): Promise<any> {

    if (!table || !rowKey || !data) {
      return;
    }

    const dataKeys = Object.keys(data);
    const cleanedData: Bigtable.GenericObject = {};

    dataKeys.map((key: string) => {

      const value = data[key];
      const sanitizedValue = (value && typeof value === "object") ?
        JSON.stringify(value) : value;

      cleanedData[key] = sanitizedValue || "";
    });

    return table.insert([{
      key: rowKey,
      data: {
        [cfName]: cleanedData,
      },
    }]);
  }

  /**
   * Parsing the stored string, and return as it is if not parsable
   * @param value
   */
  private getParsedValue(value: string) {

    let result = value;

    try {
      result = JSON.parse(value);
    } catch (error) {
      // Do Nothing
    }

    return result;
  }

  /**
   * Generic retrieve for both row and cell
   * @param rowKey
   * @param column
   */
  private async retrieve(table: Bigtable.Table, cfName: string, rowKey: string, column?: string, complete?: boolean):
    Promise<any> {

    if (!table || !rowKey) {
      return;
    }

    const columnName = column ? column || this.defaultColumn : null;
    const identifier = columnName ? `${cfName}:${columnName}` : undefined;

    const row = table.row(rowKey + "");

    const result: Bigtable.GenericObject = {};
    let rowGet = null;

    try {
      rowGet = await row.get(identifier ? [identifier] : undefined);
    } catch (error) {

      if (!error.message.startsWith("Unknown row")) {
        throw error;
      }

      // Set the result to null if it throws at row.get - Error: Unknown row
      return null;
    }

    if (!rowGet) {
      return null;
    }

    if (rowGet && columnName) {
      const singleResult = rowGet[0] &&
        rowGet[0][cfName] &&
        rowGet[0][cfName][columnName] &&
        rowGet[0][cfName][columnName][0];

      return complete ? singleResult : singleResult.value;
    }

    if (
      rowGet &&
      rowGet[0] &&
      rowGet[0].data &&
      rowGet[0].data[cfName]
    ) {
      const rowData = rowGet[0].data[cfName];
      Object.keys(rowData).forEach((columnKey: string) => {
        if (rowData[columnKey] && rowData[columnKey][0] && rowData[columnKey][0].value) {
          result[columnKey] = complete ?
            rowData[columnKey][0] :
            this.getParsedValue(rowData[columnKey][0].value);
        }
      });
    }

    return result;
  }

  /**
   * Scan and return cells based on filters
   * @param table
   * @param filter
   * @param etl
   */
  public async scanCellsInternal(
    table: Bigtable.Table,
    options: Bigtable.GenericObject,
    etl?: (result: Bigtable.GenericObject) => any,
  ): Promise<any> {

    debug("Scanning cells via filter for", this.config.name);
    return new Promise((resolve, reject) => {

      const results: Bigtable.GenericObject[] = [];

      table.createReadStream(options)
      .on("error", (error: Error) => {
        reject(error);
      })
      .on("data", (result: Bigtable.GenericObject) => {
        if (etl) {
          if (etl(result)) {
            results.push(etl(result));
          }
        } else {
          results.push(result);
        }
      })
      .on("end", () => {
        resolve(results);
      });
    });
  }

  public async scanCells(options: Bigtable.StreamParam, etl?: (result: Bigtable.GenericObject) => any): Promise<any> {
    return this.scanCellsInternal(this.table, options, etl);
  }

  /**
   * Initialization function for the client
   */
  public async init() {

    if (this.isInitialized) {
      return;
    }

    debug("Initialising..", this.config.name);

    const {
      name,
      columnFamily = DEFAULT_COLUMN_FAMILY,
      defaultColumn = DEFAULT_COLUMN,
      maxVersions = DEFAULT_MAX_VERSIONS,
      maxAgeSecond,
    } = this.config;

    this.defaultColumn = defaultColumn;

    const rule: RuleColumnFamily = {
      versions: maxVersions,
    };

    if (maxAgeSecond) {
      rule.age = {
        seconds: maxAgeSecond,
      };
      rule.union = true;
    }

    this.table = this.instance.table(name);
    const tableExists = await this.table.exists();
    if (!tableExists || !tableExists[0]) {
      await this.table.create(name);
    }

    const cFamily = this.table.family(columnFamily);
    const cFamilyExists = await cFamily.exists();
    if (!cFamilyExists || !cFamilyExists[0]) {
      await cFamily.create({
        rule,
      });
    }

    this.tableMetadata = this.instance.table(`${name}_metadata`);
    const tableMetadataExists = await this.tableMetadata.exists();
    if (!tableMetadataExists || !tableMetadataExists[0]) {
      await this.tableMetadata.create(name);
    }

    const cFamilyMetadata = this.tableMetadata.family(`${columnFamily}_metadata`);
    const cFamilyMetadataExists = await cFamilyMetadata.exists();
    if (!cFamilyMetadataExists || !cFamilyMetadataExists[0]) {
      await cFamilyMetadata.create({
        rule,
      });
    }

    this.cfName = cFamily.id;
    this.cfNameMetadata = cFamilyMetadata.id;
    this.isInitialized = true;

    if (this.minJitterMs && this.maxJitterMs) {
      const deltaJitterMs = parseInt((Math.random() * (this.maxJitterMs - this.minJitterMs)).toFixed(0), 10);
      const startJitterMs = this.minJitterMs + deltaJitterMs;
      debug("TTL Job started with jitter %s ms", startJitterMs);
      this.tov = setTimeout(() => this.job.run(), startJitterMs);
    } else {
      debug("TTL Job started");
      this.job.run();
    }

    debug("Initialised.", this.config.name);
  }

  /**
   * Add (or minus) the whole row
   * @param filter
   * @param etl
   */
  public multiAdd(rowKey: string, data: Bigtable.GenericObject, ttl?: number): Promise<any> | void {

    debug("Multi-adding cells for", this.config.name, rowKey, ttl);

    const row = this.table.row(rowKey + "");
    const insertPromises: Array<Promise<any>> = [];
    const columnNames = Object.keys(data);

    if (!columnNames.length) {
      return;
    }

    if (!data) {
      return;
    }

    if (ttl) {
      const ttlRowKey = this.getTTLRowKey(ttl);
      const ttlData: Bigtable.GenericObject = {};

      columnNames.forEach((columnName: string) => {
        const columnQualifier = `${this.cfName}#${rowKey}#${columnName}`;
        ttlData[columnQualifier] = ttl;
      });

      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, ttlData),
      );
    }

    const rules = columnNames
      .map((key: string) => {

        const value = data[key];
        if (typeof value !== "number") {
          return;
        }

        return {
          column: `${this.cfName}:${key}`,
          increment: (value || 0),
        };
      })
      .filter(
        (rule: Bigtable.GenericObject | undefined) => !!rule && rule.increment !== 0,
      ) as Bigtable.RowRule[];

    if (rules.length > 0) {
      insertPromises.push(
        row.createRules(rules),
      );
    }

    return Promise.all(insertPromises);
  }

  /**
   * Set or append a value of cell
   * @param rowKey
   * @param value
   * @param ttl in Seconds
   * @param column
   */
  public async set(rowKey: string, value: string | number, ttl?: number, column?: string): Promise<any> {

    debug("Setting cell for", this.config.name, rowKey, column, value, ttl);
    const columnName = column ? column : this.defaultColumn;
    const data = {
      [columnName]: value,
    };

    const insertPromises: Array<Promise<any>> = [];

    if (ttl) {
      const ttlRowKey = this.getTTLRowKey(ttl);
      const columnQualifier = `${this.cfName}#${rowKey}#${columnName}`;

      const ttlData = {
        [columnQualifier] : ttl,
      };

      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, ttlData),
      );
    }

    const rowExists = await this.table.row(rowKey + "").exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    insertPromises.push(
      this.insert(this.table, this.cfName, rowKey, data),
    );

    return Promise.all(insertPromises);
  }

  /**
   * Get a value of cell
   * @param rowKey
   * @param column
   */
  public get(rowKey: string, column?: string): Promise<any> | void {

    if (!rowKey) {
      return;
    }

    debug("Getting cell for", this.config.name, rowKey, column);
    const columnName = column || this.defaultColumn || "";
    return this.retrieve(this.table, this.cfName, rowKey, columnName);
  }

  /**
   * Delete a value of cell
   * @param rowKey
   * @param column
   */
  public async delete(rowKey: string, column?: string) {

    debug("Deleting for", this.config.name, rowKey, column);

    if (!rowKey) {
      return;
    }

    const row = this.table.row(rowKey + "");
    const columnName = column || this.defaultColumn || "";

    await row.deleteCells([`${this.cfName}:${columnName}`]);

    const rowExists = await this.table.row(rowKey + "").exists();
    if (!rowExists || !rowExists[0]) {
        await this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, -1);
    }
  }

  /**
   * Set values of multiple column based on objects
   * @param rowKey
   * @param columnsObject
   * @param ttl in Seconds
   */
  public async multiSet(rowKey: string, columnsObject: Bigtable.GenericObject, ttl?: number) {

    debug("Running multi-set for", this.config.name, rowKey, ttl);

    const insertPromises: Array<Promise<any>> = [];
    const columnNames = Object.keys(columnsObject);

    if (!columnNames.length) {
      return;
    }

    if (ttl) {
      const ttlRowKey = this.getTTLRowKey(ttl);
      const ttlData: Bigtable.GenericObject = {};

      columnNames.forEach((columnName: string) => {
        const columnQualifier = `${this.cfName}#${rowKey}#${columnName}`;
        ttlData[columnQualifier] = ttl;
      });

      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, ttlData),
      );
    }

    const rowExists = await this.table.row(rowKey + "").exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    insertPromises.push(
      this.insert(this.table, this.cfName, rowKey, columnsObject),
    );

    return Promise.all(insertPromises);
  }

  /**
   * Get the whole row values as an object
   * @param rowKey
   */
  public async getRow(rowKey: string): Promise<any> {
    debug("Getting row for", this.config.name, rowKey);
    return await this.retrieve(this.table, this.cfName, rowKey);
  }

  /**
   * Delete the whole row values as an object
   * @param rowKey
   */
  public async deleteRow(rowKey: string): Promise<any> {

    if (!rowKey) {
      return;
    }

    debug("Deleting row for", this.config.name, rowKey);

    const row = this.table.row(rowKey);

    return Promise.all([
      this.tableMetadata.row(COUNTS).increment(`${this.cfNameMetadata}:${COUNTS}`, -1),
      row.delete(),
    ]);
  }

  /**
   * Increase the value of the row by one if the value is integer
   * @param rowKey
   * @param column
   * @param ttl in Seconds
   */
  public async increase(rowKey: string, column?: string, ttl?: number): Promise<any> {

    if (!rowKey) {
      return;
    }

    debug("Increasing for", this.config.name, rowKey, column, ttl);

    const columnName = column || this.defaultColumn || "";
    const row = this.table.row(rowKey);

    const insertPromises: Array<Promise<any>> = [];

    if (ttl) {
      const ttlRowKey = this.getTTLRowKey(ttl);
      const columnQualifier = `${this.cfName}#${rowKey}#${columnName}`;

      const ttlData = {
        [columnQualifier] : ttl,
      };

      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, ttlData),
      );
    }

    const rowExists = await row.exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    insertPromises.push(
      row.increment(`${this.cfName}:${columnName}`, 1),
    );

    return Promise.all(insertPromises);
  }

  /**
   * Decrease the value of the row by one if the value is integer
   * @param rowKey
   * @param column
   * @param ttl in Seconds
   */
  public async decrease(rowKey: string, column?: string, ttl?: number): Promise<any> {

    if (!rowKey) {
      return;
    }

    debug("Decreasing for", this.config.name, rowKey, column, ttl);

    const columnName = column || this.defaultColumn || "";
    const row = this.table.row(rowKey);

    const insertPromises: Array<Promise<any>> = [];

    if (ttl) {
      const ttlRowKey = this.getTTLRowKey(ttl);
      const columnQualifier = `${this.cfName}#${rowKey}#${columnName}`;

      const ttlData = {
        [columnQualifier] : ttl,
      };

      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, ttlData),
      );
    }

    const rowExists = await row.exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    insertPromises.push(
      row.increment(`${this.cfName}:${columnName}`, -1),
    );

    return Promise.all(insertPromises);
  }

  /**
   * Get a count of a table
   */
  public async count(): Promise<any> {
    debug("Checking count for", this.config.name);
    const counts = await this.retrieve(this.tableMetadata, this.cfNameMetadata, COUNTS, COUNTS);
    return counts || 0;
  }

  public close() {

    debug("Closing job..", this.config.name);

    if (this.tov) {
      clearTimeout(this.tov as NodeJS.Timer);
    }

    this.job.close();
  }

  public cleanUp() {
    debug("Cleaning up, deleting table and metadata..", this.config.name);
    return Promise.all([
      this.table.delete(),
      this.tableMetadata.delete(),
    ]);
  }

}
