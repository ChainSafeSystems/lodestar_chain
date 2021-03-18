/**
 * @module db/controller/impl
 */

import {LevelUp} from "levelup";
//@ts-ignore
import level from "level";
import pushable, {Pushable} from "it-pushable";
import all from "it-all";
import {ILogger} from "@chainsafe/lodestar-utils";
import {IDatabaseController, IDatabaseOptions, IFilterOptions, IKeyValue} from "../interface";

enum Status {
  started = "started",
  stopped = "stopped",
}

export interface ILevelDBOptions extends IDatabaseOptions {
  db?: LevelUp;
}

/**
 * The LevelDB implementation of DB
 */
export class LevelDbController implements IDatabaseController<Buffer, Buffer> {
  private status = Status.stopped;
  private db: LevelUp;

  private opts: ILevelDBOptions;

  private logger: ILogger;

  constructor(opts: ILevelDBOptions, {logger}: {logger: ILogger}) {
    this.opts = opts;
    this.logger = logger;
    this.db = opts.db || level(opts.name || "beaconchain", {keyEncoding: "binary", valueEncoding: "binary"});
  }

  async start(): Promise<void> {
    if (this.status === Status.started) return;
    this.status = Status.started;

    await this.db.open();
    this.logger.info("Connected to LevelDB database", {name: this.opts.name});
  }

  async stop(): Promise<void> {
    if (this.status === Status.stopped) return;
    this.status = Status.stopped;

    await this.db.close();
  }

  async clear(): Promise<void> {
    await this.db.clear();
  }

  async get(key: Buffer): Promise<Buffer | null> {
    try {
      return await this.db.get(key);
    } catch (e: unknown) {
      if (e.notFound) {
        return null;
      }
      throw e;
    }
  }

  async put(key: Buffer, value: Buffer): Promise<void> {
    await this.db.put(key, value);
  }

  async delete(key: Buffer): Promise<void> {
    await this.db.del(key);
  }

  async batchPut(items: IKeyValue<Buffer, Buffer>[]): Promise<void> {
    const batch = this.db.batch();
    for (const item of items) batch.put(item.key, item.value);
    await batch.write();
  }

  async batchDelete(keys: Buffer[]): Promise<void> {
    const batch = this.db.batch();
    for (const key of keys) batch.del(key);
    await batch.write();
  }

  keysStream(opts?: IFilterOptions<Buffer>): Pushable<Buffer> {
    const source: Pushable<Buffer> = pushable();
    this.db
      .createKeyStream({...opts})
      .on("data", function (data) {
        source.push(data);
      })
      .on("close", function () {
        source.end();
      })
      .on("end", function () {
        source.end();
      });
    return source;
  }

  async keys(opts?: IFilterOptions<Buffer>): Promise<Buffer[]> {
    return all(this.keysStream(opts));
  }

  valuesStream(opts?: IFilterOptions<Buffer>): Pushable<Buffer> {
    const source: Pushable<Buffer> = pushable();
    this.db
      .createValueStream({...opts})
      .on("data", function (data) {
        source.push(data);
      })
      .on("close", function () {
        source.end();
      })
      .on("end", function () {
        source.end();
      });
    return source;
  }

  async values(opts?: IFilterOptions<Buffer>): Promise<Buffer[]> {
    return all(this.valuesStream(opts));
  }

  entriesStream(opts?: IFilterOptions<Buffer>): Pushable<IKeyValue<Buffer, Buffer>> {
    const source: Pushable<IKeyValue<Buffer, Buffer>> = pushable();
    this.db
      .createReadStream({...opts})
      .on("data", function (data) {
        source.push(data);
      })
      .on("close", function () {
        source.end();
      })
      .on("end", function () {
        source.end();
      });
    return source;
  }

  async entries(opts?: IFilterOptions<Buffer>): Promise<IKeyValue<Buffer, Buffer>[]> {
    return all(this.entriesStream(opts));
  }
}
