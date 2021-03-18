import fastify, {FastifyInstance, ServerOptions} from "fastify";
import fastifyCors from "fastify-cors";
import {FastifySSEPlugin} from "fastify-sse-v2";
import {IncomingMessage, Server, ServerResponse} from "http";
import * as querystring from "querystring";
import {IRestApiModules} from "./interface";
import {FastifyLogger} from "./logger/fastify";
import {defaultApiRestOptions, IRestApiOptions} from "./options";
import {registerRoutes} from "./routes";
import {errorHandler} from "./routes/error";

/**
 * REST API powered by `fastify` server.
 */
export class RestApi {
  server: FastifyInstance;

  constructor(server: FastifyInstance) {
    this.server = server;
  }

  /**
   * Initialize and start the REST API server.
   */
  static async init(opts: Partial<IRestApiOptions>, modules: IRestApiModules): Promise<RestApi> {
    const _opts = {...defaultApiRestOptions, ...opts};
    const api = new RestApi(setupServer(_opts, modules));
    const logger = modules.logger;
    if (_opts.enabled) {
      try {
        const address = await api.server.listen(_opts.port, _opts.host);
        logger.info("Started rest api server", {address});
      } catch (e: unknown) {
        logger.error("Failed to start rest api server", {host: _opts.host, port: _opts.port}, e);
        throw e;
      }
    }
    return api;
  }

  /**
   * Close the server instance.
   */
  async close(): Promise<void> {
    await this.server.close();
  }
}

function setupServer(opts: IRestApiOptions, modules: IRestApiModules): FastifyInstance {
  const server = fastify({
    logger: new FastifyLogger(modules.logger),
    ajv: {
      customOptions: {
        coerceTypes: "array",
      },
    },
    querystringParser: querystring.parse as ServerOptions["querystringParser"],
  });
  server.setErrorHandler(errorHandler);
  if (opts.cors) {
    server.register(fastifyCors as fastify.Plugin<Server, IncomingMessage, ServerResponse, Record<string, unknown>>, {
      origin: opts.cors,
    });
  }
  server.register(FastifySSEPlugin);
  const api = modules.api;
  server.decorate("config", modules.config);
  server.decorate("api", api);
  // new api
  const enabledApiNamespaces = opts.api;
  server.register(async function (instance) {
    registerRoutes(instance, enabledApiNamespaces);
  });

  return server;
}
