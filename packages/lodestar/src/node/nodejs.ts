/**
 * @module node
 */

import {AbortController} from "abort-controller";
import LibP2p from "libp2p";

import {TreeBacked} from "@chainsafe/ssz";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {allForks} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {Api} from "@chainsafe/lodestar-api";

import {IBeaconDb} from "../db";
import {INetwork, Network, ReqRespHandler} from "../network";
import {BeaconSync, IBeaconSync} from "../sync";
import {BeaconChain, IBeaconChain, initBeaconMetrics} from "../chain";
import {createMetrics, IMetrics, HttpMetricsServer} from "../metrics";
import {getApi, RestApi} from "../api";
import {TasksService} from "../tasks";
import {IBeaconNodeOptions} from "./options";
import {Eth1ForBlockProduction, Eth1ForBlockProductionDisabled, Eth1Provider} from "../eth1";
import {runNodeNotifier} from "./notifier";
import {simTestInfoTracker} from "./utils/simTest";

export * from "./options";

export interface IBeaconNodeModules {
  opts: IBeaconNodeOptions;
  config: IBeaconConfig;
  db: IBeaconDb;
  metrics: IMetrics | null;
  network: INetwork;
  chain: IBeaconChain;
  api: Api;
  sync: IBeaconSync;
  chores: TasksService;
  metricsServer?: HttpMetricsServer;
  restApi?: RestApi;
  controller?: AbortController;
}

export interface IBeaconNodeInitModules {
  opts: IBeaconNodeOptions;
  config: IBeaconConfig;
  db: IBeaconDb;
  logger: ILogger;
  libp2p: LibP2p;
  anchorState: TreeBacked<allForks.BeaconState>;
}

export enum BeaconNodeStatus {
  started = "started",
  closing = "closing",
  closed = "closed",
}

/**
 * The main Beacon Node class.  Contains various components for getting and processing data from the
 * eth2 ecosystem as well as systems for getting beacon node metadata.
 */
export class BeaconNode {
  opts: IBeaconNodeOptions;
  config: IBeaconConfig;
  db: IBeaconDb;
  metrics: IMetrics | null;
  metricsServer?: HttpMetricsServer;
  network: INetwork;
  chain: IBeaconChain;
  api: Api;
  restApi?: RestApi;
  sync: IBeaconSync;
  chores: TasksService;

  status: BeaconNodeStatus;
  private controller?: AbortController;

  constructor({
    opts,
    config,
    db,
    metrics,
    metricsServer,
    network,
    chain,
    api,
    restApi,
    sync,
    chores,
    controller,
  }: IBeaconNodeModules) {
    this.opts = opts;
    this.config = config;
    this.metrics = metrics;
    this.metricsServer = metricsServer;
    this.db = db;
    this.chain = chain;
    this.api = api;
    this.restApi = restApi;
    this.network = network;
    this.sync = sync;
    this.chores = chores;
    this.controller = controller;

    this.status = BeaconNodeStatus.started;
  }

  /**
   * Initialize a beacon node.  Initializes and `start`s the varied sub-component services of the
   * beacon node
   */
  static async init<T extends BeaconNode = BeaconNode>({
    opts,
    config,
    db,
    logger,
    libp2p,
    anchorState,
  }: IBeaconNodeInitModules): Promise<T> {
    const controller = new AbortController();
    const signal = controller.signal;

    // start db if not already started
    await db.start();

    const metrics = opts.metrics.enabled ? createMetrics(opts.metrics, anchorState) : null;
    if (metrics) {
      initBeaconMetrics(metrics, anchorState);
    }

    const chain = new BeaconChain(opts.chain, {
      config,
      db,
      logger: logger.child(opts.logger.chain),
      metrics,
      anchorState,
    });
    const network = new Network(opts.network, {
      config,
      libp2p,
      logger: logger.child(opts.logger.network),
      metrics,
      chain,
      db,
      reqRespHandler: new ReqRespHandler({db, chain}),
      signal,
    });
    const sync = new BeaconSync(opts.sync, {
      config,
      db,
      chain,
      metrics,
      network,
      logger: logger.child(opts.logger.sync),
    });
    const chores = new TasksService({
      config,
      signal: controller.signal,
      db,
      chain,
      sync,
      network,
      logger: logger.child(opts.logger.chores),
    });

    const api = getApi({
      config,
      logger: logger.child(opts.logger.api),
      db,
      eth1: opts.eth1.enabled
        ? new Eth1ForBlockProduction({
            config,
            db,
            eth1Provider: new Eth1Provider(config, opts.eth1),
            logger: logger.child(opts.logger.eth1),
            opts: opts.eth1,
            signal,
          })
        : new Eth1ForBlockProductionDisabled(),
      sync,
      network,
      chain,
      metrics,
    });

    const metricsServer = metrics
      ? new HttpMetricsServer(opts.metrics, {metrics, logger: logger.child(opts.logger.metrics)})
      : undefined;
    if (metricsServer) {
      await metricsServer.start();
    }

    const restApi = new RestApi(opts.api.rest, {
      config,
      logger: logger.child(opts.logger.api),
      api,
      metrics,
    });
    if (opts.api.rest.enabled) {
      await restApi.listen();
    }

    await network.start();
    chores.start();

    void runNodeNotifier({network, chain, sync, config, logger, signal});

    const bn = new this({
      opts,
      config,
      db,
      metrics,
      metricsServer,
      network,
      chain,
      api,
      restApi,
      sync,
      chores,
      controller,
    }) as T;

    if (opts.chain.runChainStatusNotifier) {
      const onStop = simTestInfoTracker(bn, logger);
      controller.signal.addEventListener("abort", onStop);
    }

    return bn;
  }

  /**
   * Stop beacon node and its sub-components.
   */
  async close(): Promise<void> {
    if (this.status === BeaconNodeStatus.started) {
      this.status = BeaconNodeStatus.closing;
      await this.chores.stop();
      this.sync.close();
      await this.network.stop();
      if (this.metricsServer) await this.metricsServer.stop();
      if (this.restApi) await this.restApi.close();

      this.chain.close();
      await this.db.stop();
      if (this.controller) this.controller.abort();
      this.status = BeaconNodeStatus.closed;
    }
  }
}
