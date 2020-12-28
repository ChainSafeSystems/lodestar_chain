import chai, {expect} from "chai";
import chaiAsPromised from "chai-as-promised";
import pipe from "it-pipe";
import all from "it-all";
import {config} from "@chainsafe/lodestar-config/minimal";
import {Goodbye, Metadata, Ping, ResponseBody, SignedBeaconBlock, Status} from "@chainsafe/lodestar-types";
import {Method, Methods, ReqRespEncoding} from "../../../../src/constants";
import {responseDecode} from "../../../../src/network/reqresp/request/responseDecode";
import {responseEncodeSuccess} from "../../../../src/network/reqresp/response/responseEncode";
import {arrToSource, createStatus, generateEmptySignedBlocks, isEqualSszType} from "./utils";

chai.use(chaiAsPromised);

describe("network / reqresp / encode decode / response body", () => {
  interface IResponseTypes {
    [Method.Status]: Status;
    [Method.Goodbye]: Goodbye;
    [Method.Ping]: Ping;
    [Method.Metadata]: Metadata;
    [Method.BeaconBlocksByRange]: SignedBeaconBlock;
    [Method.BeaconBlocksByRoot]: SignedBeaconBlock;
  }

  const testCases: {[P in keyof IResponseTypes]: IResponseTypes[P][][]} = {
    [Method.Status]: [[createStatus()]],
    [Method.Goodbye]: [[BigInt(0)], [BigInt(1)]],
    [Method.Ping]: [[BigInt(0)], [BigInt(1)]],
    [Method.Metadata]: [],
    [Method.BeaconBlocksByRange]: [generateEmptySignedBlocks(2)],
    [Method.BeaconBlocksByRoot]: [generateEmptySignedBlocks(2)],
  };

  const encodings: ReqRespEncoding[] = [ReqRespEncoding.SSZ_SNAPPY];

  for (const encoding of encodings) {
    for (const [_method, _responsesChunks] of Object.entries(testCases)) {
      // Cast to more generic types, type by index is useful only at declaration of `testCases`
      const method = _method as keyof typeof testCases;
      const responsesChunks = _responsesChunks as ResponseBody[][];

      responsesChunks.forEach((responseChunks, i) => {
        it(`${encoding} ${method} - resp ${i}`, async function () {
          const returnedResponses = await pipe(
            arrToSource(responseChunks),
            responseEncodeSuccess(config, method, encoding),
            responseDecode(config, method, encoding, this.timeout()),
            all
          );

          const type = Methods[method].responseSSZType(config);
          if (!type) throw Error("no type");

          returnedResponses.forEach((returnedResponse, j) => {
            expect(isEqualSszType(type, returnedResponse, responseChunks[j] as ResponseBody)).to.equal(
              true,
              "decoded response does not match encoded response"
            );
          });
        });
      });
    }
  }
});