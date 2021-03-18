import {assert} from "chai";
import Axios from "axios";
import MockAdapter from "axios-mock-adapter";
import {HttpClient} from "../../../src/util";
import {testLogger} from "../../utils/logger";

interface IUser {
  id?: number;
  name: string;
}

describe("httpClient test", () => {
  let mock: MockAdapter;
  let httpClient: HttpClient;

  beforeEach(() => {
    mock = new MockAdapter(Axios);
    httpClient = new HttpClient({}, {logger: testLogger()});
  });

  it("should handle successful GET request correctly", async () => {
    mock.onGet("/users/1").reply(200, {id: 1, name: "John Smith"});
    const user: IUser = await httpClient.get<IUser>("/users/1");
    assert.equal(user.id, 1);
    assert.equal(user.name, "John Smith");
  });

  it("should handle successful GET request with query correctly", async () => {
    mock.onGet("/users?id=1").reply(200, {id: 1, name: "John Smith"});
    const user: IUser = await httpClient.get<IUser>("/users", {id: 1});
    assert.equal(user.id, 1);
    assert.equal(user.name, "John Smith");
  });

  it("should handle successful POST request correctly", async () => {
    mock.onPost("/users", {name: "New comer"}).reply(200, "The user 'New comer' was saved successfully");
    const result: string = await httpClient.post<IUser, string>("/users", {name: "New comer"});
    assert.equal(result, "The user 'New comer' was saved successfully");
  });

  it("should handle http status code 404 correctly", async () => {
    try {
      await httpClient.get<IUser>("/wrong_url");
    } catch (e: unknown) {
      assert.equal(e.message, "Endpoint not found");
    }
  });

  it("should handle http status code 500 correctly", async () => {
    mock.onGet("/users/!").reply(500, "internal server error");
    try {
      await httpClient.get<IUser>("/users/!");
    } catch (e: unknown) {
      assert.equal(e.message, "Request failed with response status 500");
    }
  });
});
