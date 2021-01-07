// @ts-ignore
import FilecoinClient from "@glif/filecoin-rpc-client";

import { Asset } from "../database/models";
import {
    FilecoinNetwork,
    FilecoinTransaction,
} from "../database/models/FilecoinTransaction";
import {
    FILECOIN_MAINNET_TOKEN,
    FILECOIN_MAINNET_URL,
    FILECOIN_TESTNET_TOKEN,
    FILECOIN_TESTNET_URL,
} from "../env";
import { CYAN, RESET, SECONDS, sleep } from "../utils";
import { IndexerClass } from "./base";
import { Filfox } from "./filecoin-filfox";

type FilecoinClient = { request(method: string, ...args: any[]): Promise<any> };

interface ClientPlusFilfox {
    client: FilecoinClient;
    filfox?: Filfox;
}

// TODO: Use database to track addresses.
export const WATCHED_ADDRESSES = {
    [FilecoinNetwork.Mainnet]: ["f15wjyn36z6x5ypq7f73yaolqbxyiiwkg5mmuyo2q"],
    [FilecoinNetwork.Testnet]: [
        "t1v2ftlxhedyoijv7uqgxfygiziaqz23lgkvks77i",
        "t1cfxqaivmpcv2rxdd2ew75u5duyabpkri2f6lddy",
    ],
};

export class FilecoinIndexer extends IndexerClass<
    ClientPlusFilfox,
    FilecoinNetwork
> {
    name = "Filecoin";

    loopCount = 0;

    constructor(network: FilecoinNetwork) {
        super(network);
    }

    async connect() {
        if (this.client) {
            return this.client;
        }

        let config;
        let filfox: Filfox | undefined;

        switch (this.network) {
            case FilecoinNetwork.Testnet:
                config = {
                    apiAddress: FILECOIN_TESTNET_URL,
                    token: FILECOIN_TESTNET_TOKEN,
                };
                break;
            case FilecoinNetwork.Mainnet:
                config = {
                    apiAddress: FILECOIN_MAINNET_URL,
                    token: FILECOIN_MAINNET_TOKEN,
                };
                filfox = new Filfox(FilecoinNetwork.Mainnet);
                break;
            default:
                throw new Error(`Unsupported Filecoin network ${this.network}`);
        }

        const client: FilecoinClient = new FilecoinClient(config);
        this.client = {
            client,
            filfox,
        };

        return this.client;
    }

    async loop({ client, filfox }: ClientPlusFilfox) {
        const chainState = await this.readDatabase();

        const asset = await Asset.findOneOrFail({
            name: "FIL",
        });

        const latestHeight = await this.getLatestHeight();

        if (chainState.synced === 0) {
            console.log(
                `[${this.name.toLowerCase()}][${
                    this.network
                }] Starting indexer fom block ${CYAN}${latestHeight}${RESET}`
            );

            chainState.synced = latestHeight;
            await chainState.save();
        } else if (latestHeight > chainState.synced) {
            const synced = chainState.synced + 1 || latestHeight;

            console.log(
                `[${this.name.toLowerCase()}][${
                    this.network
                }] Syncing from ${CYAN}${
                    chainState.synced
                }${RESET} to ${CYAN}${latestHeight}${RESET}`
            );

            for (const watchedAddress of WATCHED_ADDRESSES[this.network]) {
                if (filfox && this.loopCount % 100 === 0) {
                    try {
                        let page = 0;
                        const size = 10;
                        while (page < 1) {
                            const {
                                deposits,
                                totalCount,
                            } = await filfox.fetchDeposits(
                                watchedAddress,
                                undefined,
                                page,
                                size
                            );

                            for (const transactionDetails of deposits) {
                                try {
                                    const exists = !!(await FilecoinTransaction.findOne(
                                        {
                                            cid: transactionDetails.cid,
                                        }
                                    ));

                                    if (!exists) {
                                        new FilecoinTransaction(
                                            chainState,
                                            asset,
                                            transactionDetails
                                        ).save();

                                        console.log(
                                            `[${this.name.toLowerCase()}][${
                                                this.network
                                            }] FOUND TRANSACTION THROUGH FILFOX:`,
                                            transactionDetails
                                        );
                                    }
                                } catch (error) {
                                    console.error(error);
                                }
                            }

                            if (page * size >= totalCount) {
                                break;
                            }

                            page += 1;
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }

                const latestTXs = await client.request(
                    "StateListMessages",
                    {
                        Version: 0,
                        To: watchedAddress,
                        From: null,
                        Nonce: 0,
                        Value: "0",
                        GasPrice: "0",
                        GasLimit: 0,
                        Method: 0,
                        Params: null,
                    },
                    [],
                    synced
                );

                if (latestTXs) {
                    for (const cid of latestTXs) {
                        try {
                            const transactionDetails = await client.request(
                                "ChainGetMessage",
                                cid
                            );

                            if (this.network === FilecoinNetwork.Testnet) {
                                transactionDetails.To = transactionDetails.To.replace(
                                    /^f/,
                                    "t"
                                );
                                transactionDetails.From = transactionDetails.From.replace(
                                    /^f/,
                                    "t"
                                );
                            }
                            new FilecoinTransaction(chainState, asset, {
                                cid: cid["/"],
                                to: transactionDetails.To,
                                amount: transactionDetails.Value,
                                params: transactionDetails.Params,
                                blocknumber: latestHeight,
                                nonce: transactionDetails.Nonce,
                            }).save();

                            console.log(
                                `[${this.name.toLowerCase()}][${
                                    this.network
                                }] Saved transaction:`,
                                transactionDetails
                            );
                        } catch (error) {
                            console.error(error);
                        }
                    }
                }
            }

            chainState.synced = latestHeight;
            await chainState.save();

            this.loopCount += 1;
        } else {
            console.log(
                `[${this.name.toLowerCase()}][${
                    this.network
                }] Already synced up to ${CYAN}${latestHeight}${RESET}`
            );
        }
    }

    async readTXFromDatabase(cid: string) {
        return await FilecoinTransaction.findOneOrFail({
            cid,
            network: this.network,
        });
    }

    lastFetchedHeight: { height: number; time: number } | null = null;
    async getLatestHeight(_client?: ClientPlusFilfox): Promise<number> {
        // If the height was fetched within 10 seconds, return it.
        if (
            this.lastFetchedHeight &&
            Date.now() - this.lastFetchedHeight.time < 10 * SECONDS
        ) {
            return this.lastFetchedHeight.height;
        }

        // Fetch latest height.
        const { client } = _client || (await this.connect());
        const chainHead = await client.request("ChainHead");
        const height = chainHead.Height;

        // Store height.
        this.lastFetchedHeight = {
            height,
            time: Date.now(),
        };

        return height;
    }
}
