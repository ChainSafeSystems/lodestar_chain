/**
 * @module logger
 */

import {createLogger, Logger} from "winston";
import {Context, defaultLogLevel, ILogger, ILoggerOptions, LogLevel, logLevelNum} from "./interface";
import chalk from "chalk";
import {getFormat} from "./format";
import {Writable} from "stream";
import {TransportOpts, TransportType, fromTransportOpts} from "./transport";

const defaultTransportOpts: TransportOpts = {type: TransportType.console};

type DefaultMeta = {
  module: string;
};

export class WinstonLogger implements ILogger {
  private winston: Logger;
  private _level: LogLevel;
  private _options: Partial<ILoggerOptions>;
  private _transportOptsArr: TransportOpts[];

  constructor(options: Partial<ILoggerOptions> = {}, transportOptsArr: TransportOpts[] = [defaultTransportOpts]) {
    // `options.level` can override the level in the transport
    // This is necessary for child logger opts to take effect
    let minLevel = options?.level;
    for (const transportOpts of transportOptsArr) {
      transportOpts.level = getMinLevel(options?.level, transportOpts.level); // General level may override transport level
      minLevel = getMinLevel(minLevel, transportOpts.level); // Compute the minLevel from general and all transports
    }

    this.winston = createLogger({
      level: options?.level || defaultLogLevel,
      defaultMeta: {module: options?.module || ""} as DefaultMeta,
      format: getFormat(options || {}),
      transports: transportOptsArr.map((transportOpts) => fromTransportOpts(transportOpts)),
      exitOnError: false,
    });
    this._level = minLevel || defaultLogLevel;
    // Store for child logger
    this._options = options;
    this._transportOptsArr = transportOptsArr;
  }

  mute(): void {
    this.winston.silent = true;
  }

  unmute(): void {
    this.winston.silent = false;
  }

  error(message: string, context?: Context, error?: Error): void {
    this.createLogEntry(LogLevel.error, message, context, error);
  }

  warn(message: string, context?: Context, error?: Error): void {
    this.createLogEntry(LogLevel.warn, message, context, error);
  }

  info(message: string, context?: Context, error?: Error): void {
    this.createLogEntry(LogLevel.info, message, context, error);
  }

  important(message: string, context?: Context, error?: Error): void {
    this.createLogEntry(LogLevel.info, chalk.red(message), context, error);
  }

  verbose(message: string, context?: Context, error?: Error): void {
    this.createLogEntry(LogLevel.verbose, message, context, error);
  }

  debug(message: string, context?: Context, error?: Error): void {
    this.createLogEntry(LogLevel.debug, message, context, error);
  }

  silly(message: string, context?: Context, error?: Error): void {
    this.createLogEntry(LogLevel.silly, message, context, error);
  }

  profile(message: string, option?: {level: string; message: string}): void {
    this.winston.profile(message, option);
  }

  stream(): Writable {
    throw Error("Not implemented");
  }

  child(options: ILoggerOptions): WinstonLogger {
    // Concat module tags
    if (options.module) options.module = [this._options.module, options.module].filter(Boolean).join(" ");
    return new WinstonLogger({...this._options, ...options}, this._transportOptsArr);
  }

  private createLogEntry(level: LogLevel, message: string, context?: Context, error?: Error): void {
    // don't propagate if silenced or message level is more detailed than logger level
    if (logLevelNum[level] > logLevelNum[this._level]) {
      return;
    }
    this.winston[level](message, {context, error});
  }
}

/** Return the min LogLevel from multiple transports */
function getMinLevel(...levelsArg: (LogLevel | undefined)[]): LogLevel {
  const levels = levelsArg.filter((level): level is LogLevel => Boolean(level));

  // Only if there are no levels to compute min from, consider defaultLogLevel
  if (levels.length === 0) return defaultLogLevel;

  return levels.reduce(
    // error: 0, warn: 1, info: 2, ...
    (minLevel, level) => (logLevelNum[level] > logLevelNum[minLevel] ? level : minLevel)
  );
}
