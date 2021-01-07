import Axios from "axios";
import BigNumber from "bignumber.js";
import { FilecoinNetwork } from "../database/models";

const FILFOX_URL = "https://filfox.info/api/v1/";

const SECONDS = 1000;

interface FilecoinDeposit {
    cid: string;
    to: string;
    amount: string;
    params: string;
    blocknumber: number;
    nonce: number;
}

export class Filfox {
    constructor(network: FilecoinNetwork = FilecoinNetwork.Mainnet) {
        if (network !== FilecoinNetwork.Mainnet) {
            throw new Error(`Network ${network} not supported by Filscan.`);
        }
    }

    fetchDeposits = async (
        address: string,
        paramsFilterBase64: string | undefined = undefined,
        page = 0,
        size = 100
    ): Promise<{ deposits: FilecoinDeposit[]; totalCount: number }> => {
        const messagesURL = `${FILFOX_URL}address/${address}/messages?pageSize=${size}&page=${page}&detailed`;

        const messagesResponse = (
            await Axios.get<FilscanAddressMessages | FilscanError>(
                messagesURL,
                {
                    timeout: 60 * SECONDS,
                }
            )
        ).data;

        if (messagesResponse.error !== undefined) {
            throw new Error(
                `Unable to fetch Filecoin messages: ${messagesResponse.error}`
            );
        }

        const { messages, totalCount } = messagesResponse;

        return {
            deposits: messages
                .filter((message) => message.to === address)
                .map(
                    (message): FilecoinDeposit => {
                        return {
                            cid: message.cid,
                            to: message.to,
                            amount: message.value,
                            params: message.params,
                            blocknumber: message.height,
                            nonce: message.nonce,
                        };
                    }
                )
                .filter(
                    (message) =>
                        paramsFilterBase64 === undefined ||
                        paramsFilterBase64 === null ||
                        message.params === paramsFilterBase64
                ),
            totalCount,
        };
    };
}

interface FilscanSuccess {
    statusCode: undefined;
    message: undefined;
    error: undefined;
}

interface FilscanAddressMessages extends FilscanSuccess {
    totalCount: number; // 167;
    messages: Array<{
        cid: string; // "bafy2bzacebhc5rzrtquqjghkgpob6hxgsbz4iqzx73erjj3tu53zgsa62uoy6";
        height: number; // 388742;
        timestamp: number; // 1609968660;
        from: string; // "f12e32a3szzf6zsl6d3s5lnal6heypkzlb5nizvrq";
        to: string; // "f15wjyn36z6x5ypq7f73yaolqbxyiiwkg5mmuyo2q";
        nonce: number; // 1;
        value: string; // "795400000000000000000";
        method: string; // "Send";
        params: string; // "b1o1UTNEV0FjSXZEZWpjMzF6UlRXUGNrdk1ZdTg5YW9tUEpyUVZZOUpaZw==";
        receipt: {
            exitCode: 0;
            return: "";
        };
    }>;
    methods: ["Send"];
}

interface FilscanError {
    statusCode: number; // 400;
    message: string; // "Bad Request";
    error: string; // "Invalid pagination params";
}

type FilscanHeight = Array<{
    height: number; // 389254;
    timestamp: number; // 1609984020;
    messageCount: number; // 342;
    blocks: [
        {
            cid: string; // "bafy2bzacea2cbjfzqmxa67bj7ijzp4xjsn3jgds7ernjn6q7oqc365sqya3mq";
            miner: string; // "f014804";
            minerTag: {
                name: string; // "蜂巢云矿池";
                signed: boolean; // false;
            };
            messageCount: number; // 239;
            winCount: number; // 1;
            reward: string; // "17812580419321249004";
            penalty: string; // "0";
        }
    ];
}>;
