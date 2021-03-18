import Axios, {AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse} from "axios";
import {ILogger} from "@chainsafe/lodestar-utils";
import querystring from "querystring";

export interface IHttpClientOptions {
  // Add more options if needed
  urlPrefix: string;
}

export interface IHttpQuery {
  [key: string]: string | number | boolean | string[] | number[];
}

export class HttpClient {
  private client: AxiosInstance;
  private logger: ILogger;

  constructor(opt: Partial<IHttpClientOptions>, {logger}: {logger: ILogger}) {
    this.client = Axios.create({
      baseURL: opt.urlPrefix || "",
      timeout: 4000,
    });
    this.logger = logger;
  }

  async get<T>(url: string, query?: IHttpQuery, opts?: AxiosRequestConfig): Promise<T> {
    try {
      if (query) url += "?" + querystring.stringify(query);
      const result: AxiosResponse<T> = await this.client.get<T>(url, opts);
      this.logger.verbose("HttpClient GET", {url, result: JSON.stringify(result.data)});
      return result.data;
    } catch (e: unknown) {
      this.logger.verbose("HttpClient GET error", {url}, e);
      throw this.handleError(e);
    }
  }

  async post<T, T2>(url: string, data: T, query?: IHttpQuery): Promise<T2> {
    try {
      if (query) url += "?" + querystring.stringify(query);
      const result: AxiosResponse<T2> = await this.client.post(url, data);
      this.logger.verbose("HttpClient POST", {url, result: JSON.stringify(result.data)});
      return result.data;
    } catch (e: unknown) {
      this.logger.verbose("HttpClient POST error", {url}, e);
      throw this.handleError(e);
    }
  }

  private handleError = (error: AxiosError & NodeJS.ErrnoException): Error => {
    if (error.response) {
      if (error.response.status === 404) {
        error.message = "Endpoint not found";
        if (error.request && error.request.path) {
          error.message += `: ${error.request.path}`;
        }
      } else {
        error.message = error.response.data.message || "Request failed with response status " + error.response.status;
      }
    } else if (error.request) {
      if (error.syscall && error.errno)
        error.message = error.syscall + " " + error.errno + " " + error.request._currentUrl;
    }
    error.stack = "";
    return error;
  };
}
