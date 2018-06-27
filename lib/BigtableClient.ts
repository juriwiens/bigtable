import * as Bigtable from "@google-cloud/bigtable";
import * as Debug from "debug";

import { BigtableClientConfig } from "./interfaces";
import { BigtableFactory } from "..";

const debug = Debug("bigtable:client");

const DEFAULT_COLUMN = "value";
const COUNTS = "counts";
const DEFAULT_MAX_VERSIONS = 1;

export class BigtableClient {

  private config: BigtableClientConfig;
  private instance: any; // TODO: get the correct type of instance
  private table!: any; // TODO: get the correct type of table
  private tableMetadata!: any;
  private tov!: any;

  private defaultColumn!: string;
  private cfName!: string;
  private cfNameMetadata!: string;
  private intervalInMs: number;
  private isInitialized: boolean;

  constructor(config: BigtableClientConfig, instance: any, intervalInMs: number) {

    this.instance = instance;
    this.intervalInMs = intervalInMs;
    this.config = config;
    this.isInitialized = false;
  }

  private runJob() {

    this.tov = setTimeout(() => {

      this.deleteExpiredData()
        .then(() => {
          this.runJob();
        })
        .catch((error: Error) => {
          debug(error);
          this.runJob();
        });

    }, this.intervalInMs);
  }

  private async deleteExpiredData() {

    const etl = (result: any) => {
      const ttl: object = result.data[this.cfNameMetadata].ttl;

      if (!ttl) {
        return;
      }

      return {
        rowKey: result.id,
        value: ttl[0].value,
        timestamp: ttl[0].timestamp,
      };
    };

    const filteredRowKeys = (await this.scanCells(this.tableMetadata, [], etl))
      .filter((metaCell: any) => !!metaCell)
      .filter((metaCell: any) => (metaCell.timestamp / 1000) < (Date.now() - (metaCell.value * 1000)))
      .map((metaCell: any) => metaCell.rowKey);

    const promiseDeletions = filteredRowKeys
      .map((rowKey: any) => ({key: rowKey.split("#")[0], column: rowKey.split(":")[1]}))
      .map((cell: any) => this.delete(cell.key, cell.column));

    const promiseMetadataDeletions = filteredRowKeys
      .map((rowKey: any) => this.tableMetadata.row(rowKey).delete());

    await Promise.all(promiseDeletions.concat(promiseMetadataDeletions));
  }

  /**
   * Parsing the stored string, and return as it is if not parsable
   * @param value
   */
  private getParsedValue(value: any) {

    let result = value;

    try {
      result = JSON.parse(value);
    } catch (error) {
      // Do Nothing
    }

    return result;
  }

  /**
   * Generic insert for both row and cell
   * @param rowKey
   * @param data
   */
  private async insert(table: any, cfName: string, rowKey: string, data: any): Promise<any> {

    if (!table || !rowKey || !data) {
      return;
    }

    const dataKeys = Object.keys(data);
    const cleanedData: any = {};

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
   * Generic retrieve for both row and cell
   * @param rowKey
   * @param column
   */
  public async retrieve(table: any, cfName: string, rowKey: string, column?: string, complete?: boolean): Promise<any> {

    if (!table || !rowKey) {
      return;
    }

    const columnName = column ? column || this.defaultColumn : null;
    const identifier = columnName ? `${cfName}:${columnName}` : undefined;

    const row = table.row(rowKey + "");

    const result: any = {};
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
   * @param filter
   * @param etl
   */
  private async scanCells(table: any, filter: any[], etl?: (result: any) => any): Promise<any> {

    return new Promise((resolve, reject) => {

      const results: any[] = [];

      table.createReadStream({
        filter,
      })
        .on("error", (error: Error) => {
          reject(error);
        })
        .on("data", (result: any) => {
          results.push(etl ? etl(result) : result);
        })
        .on("end", (result: any) => {
          resolve(results);
        });
    });
  }

  /**
   * Initialization function for the client
   */
  public async init() {

    if (this.isInitialized) {
      return;
    }

    const {
      name,
      columnFamily,
      defaultColumn = DEFAULT_COLUMN,
      defaultValue,
      maxVersions = DEFAULT_MAX_VERSIONS,
    } = this.config;

    this.defaultColumn = defaultColumn;

    this.table = this.instance.table(name);
    const tableExists = await this.table.exists();
    if (!tableExists || !tableExists[0]) {
      await this.table.create(name);
    }

    const cFamily = this.table.family(columnFamily);
    const cFamilyExists = await cFamily.exists();
    if (!cFamilyExists || !cFamilyExists[0]) {
      await cFamily.create({
        versions: maxVersions,
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
        versions: maxVersions,
      });
    }

    this.cfName = cFamily.familyName;
    this.cfNameMetadata = cFamilyMetadata.familyName;
    this.isInitialized = true;

    this.runJob();
  }

  /**
   * Add (or minus) the whole row
   * @param filter
   * @param etl
   */
  public multiAdd(rowKey: string, data: any, ttl?: number): Promise<any> | void {

    const row = this.table.row(rowKey + "");
    const insertPromises: Array<Promise<any>> = [];

    if (!data) {
      return;
    }

    const columnNames = Object.keys(data);
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
      .filter((rule: any) => rule.increment !== 0);

    if (rules.length > 0) {
      insertPromises.push(
        row.createRules(rules),
      );
    }

    if (ttl) {
      columnNames.forEach((columnName: string) => {
        const ttlRowKey = `${rowKey}#${this.cfName}:${columnName}`;
        insertPromises.push(
          this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, {ttl}),
        );
      });
    }

    return Promise.all(insertPromises);
  }

  /**
   * Set or append a value of cell
   * @param rowKey
   * @param value
   * @param ttl
   * @param column
   */
  public async set(rowKey: string, value: string, ttl?: number, column?: string): Promise<any> {

    const columnName = column ? column : this.defaultColumn;
    const data = {
      [columnName]: value,
    };

    const ttlRowKey = `${rowKey}#${this.cfName}:${columnName}`;
    const insertPromises: Array<Promise<any>> = [
      this.insert(this.table, this.cfName, rowKey, data),
    ];

    const rowExists = await this.table.row(rowKey + "").exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    if (ttl) {
      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, {ttl}),
      );
    }

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

    const columnName = column || this.defaultColumn || "";

    return this.retrieve(this.table, this.cfName, rowKey, columnName);
  }

  /**
   * Delete a value of cell
   * @param rowKey
   * @param column
   */
  public async delete(rowKey: string, column?: string) {

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
   * @param ttl
   */
  public async multiSet(rowKey: string, columnsObject: any, ttl?: number) {

    const keys = Object.keys(columnsObject);

    if (!keys.length) {
      return;
    }

    const insertPromises: Array<Promise<any>> = [
      this.insert(this.table, this.cfName, rowKey, columnsObject),
    ];

    const rowExists = await this.table.row(rowKey + "").exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    if (ttl) {
      keys.forEach((columnName: string) => {
        const ttlRowKey = `${rowKey}#${this.cfName}:${columnName}`;
        insertPromises.push(
          this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, {ttl}),
        );
      });
    }

    return Promise.all(insertPromises);
  }

  /**
   * Get the whole row values as an object
   * @param rowKey
   */
  public async getRow(rowKey: string): Promise<any> {

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
   * @param ttl
   */
  public async increase(rowKey: string, column?: string, ttl?: number): Promise<any> {

    if (!rowKey) {
      return;
    }

    const columnName = column || this.defaultColumn || "";
    const row = this.table.row(rowKey);

    const insertPromises: Array<Promise<any>> = [
      row.increment(`${this.cfName}:${columnName}`, 1),
    ];

    const rowExists = await row.exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    if (ttl) {
      const ttlRowKey = `${rowKey}#${this.cfName}:${columnName}`;
      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, {ttl}),
      );
    }

    return Promise.all(insertPromises);
  }

  /**
   * Decrease the value of the row by one if the value is integer
   * @param rowKey
   * @param column
   * @param ttl
   */
  public async decrease(rowKey: string, column?: string, ttl?: number): Promise<any> {

    if (!rowKey) {
      return;
    }

    const columnName = column || this.defaultColumn || "";
    const row = this.table.row(rowKey);

    const insertPromises: Array<Promise<any>> = [
      row.increment(`${this.cfName}:${columnName}`, -1),
    ];

    const rowExists = await row.exists();
    if (!rowExists || !rowExists[0]) {
      insertPromises.push(
        this.tableMetadata.row(COUNTS)
          .increment(`${this.cfNameMetadata}:${COUNTS}`, 1),
      );
    }

    if (ttl) {
      const ttlRowKey = `${rowKey}#${this.cfName}:${columnName}`;
      insertPromises.push(
        this.insert(this.tableMetadata, this.cfNameMetadata, ttlRowKey, {ttl}),
      );
    }

    return Promise.all(insertPromises);
  }

  /**
   * Get a count of a table
   */
  public async count(): Promise<any> {

    const counts = await this.retrieve(this.tableMetadata, this.cfNameMetadata, COUNTS, COUNTS);
    return counts || 0;
  }

  /**
   * Check the remainding ttl of cell
   * @param rowKey
   * @param column
   */
  public async ttl(rowKey: string, column?: string): Promise<any> {

    const columnName = column || this.defaultColumn || "";
    const ttlRowKey = `${rowKey}#${this.cfName}:${columnName}`;

    const ttl = await this.retrieve(this.tableMetadata, this.cfNameMetadata, ttlRowKey, "ttl");
    const rowComplete = await this.retrieve(this.table, this.cfName, rowKey, columnName, true);
    const rowTimestamp = parseInt(rowComplete.timestamp, 10);

    const diff = (rowTimestamp / 1000) - (Date.now() - (ttl * 1000));
    const diffSec = parseInt((diff / 1000).toFixed(0), 10);

    return diffSec >= 0 ? diffSec : 0;
  }

  public close() {
    if (this.tov) {
      clearTimeout(this.tov);
    }
  }
}
