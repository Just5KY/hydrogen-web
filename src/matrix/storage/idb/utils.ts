/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { IDBRequestError } from "./error";
import { StorageError } from "../common";

let needsSyncPromise = false;

/* should be called on legacy platforms to see
   if transactions close before draining the microtask queue (IE11 on Windows 7).
   If this is the case, promises need to be resolved
   synchronously from the idb request handler to prevent the transaction from closing prematurely.
*/
export async function checkNeedsSyncPromise(): Promise<boolean> {
    // important to have it turned off while doing the test,
    // otherwise reqAsPromise would not fail
    needsSyncPromise = false;
    const NAME = "test-idb-needs-sync-promise";
    const db = await openDatabase(NAME, db => {
        db.createObjectStore("test", {keyPath: "key"});
    }, 1);
    const txn = db.transaction("test", "readonly");
    try {
        await reqAsPromise(txn.objectStore("test").get(1));
        await reqAsPromise(txn.objectStore("test").get(2));
    } catch (err) {
        // err.name would be either TransactionInactiveError or InvalidStateError,
        // but let's not exclude any other failure modes
        needsSyncPromise = true;
    }
    // we could delete the store here, 
    // but let's not create it on every page load on legacy platforms,
    // and just keep it around
    return needsSyncPromise;
}

// storage keys are defined to be unsigned 32bit numbers in KeyLimits, which is assumed by idb
export function encodeUint32(n: number): string {
    const hex = n.toString(16);
    return "0".repeat(8 - hex.length) + hex;
}

// used for logs where timestamp is part of key, which is larger than 32 bit
export function encodeUint64(n: number): string {
    const hex = n.toString(16);
    return "0".repeat(16 - hex.length) + hex;
}

export function decodeUint32(str: string): number {
    return parseInt(str, 16);
}

type CreateObjectStore = (db : IDBDatabase, txn: IDBTransaction | null, oldVersion: number, version: number) => any

export function openDatabase(name: string, createObjectStore: CreateObjectStore, version: number, idbFactory: IDBFactory = window.indexedDB): Promise<IDBDatabase> {
    const req = idbFactory.open(name, version);
    req.onupgradeneeded = (ev : IDBVersionChangeEvent) => {
        const req = ev.target as IDBRequest<IDBDatabase>;
        const db = req.result;
        const txn = req.transaction;
        const oldVersion = ev.oldVersion;
        createObjectStore(db, txn, oldVersion, version);
    }; 
    return reqAsPromise(req);
}

export function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.addEventListener("success", event => {
            resolve((event.target as IDBRequest<T>).result);
            // @ts-ignore
            needsSyncPromise && Promise._flush && Promise._flush();
        });
        req.addEventListener("error", event => {
            const error = new IDBRequestError(event.target as IDBRequest<T>);
            reject(error);
            // @ts-ignore
            needsSyncPromise && Promise._flush && Promise._flush();
        });
    });
}

export function txnAsPromise(txn): Promise<void> {
    let error;
    return new Promise((resolve, reject) => {
        txn.addEventListener("complete", () => {
            resolve();
            // @ts-ignore
            needsSyncPromise && Promise._flush && Promise._flush();
        });
        txn.addEventListener("error", event => {
            const request = event.target;
            // catch first error here, but don't reject yet,
            // as we don't have access to the failed request in the abort event handler
            if (!error && request) {
                error = new IDBRequestError(request);
            }
        });
        txn.addEventListener("abort", event => {
            if (!error) {
                const txn = event.target;
                const dbName = txn.db.name;
                const storeNames = Array.from(txn.objectStoreNames).join(", ")
                error = new StorageError(`Transaction on ${dbName} with stores ${storeNames} was aborted.`);
            }
            reject(error);
            // @ts-ignore
            needsSyncPromise && Promise._flush && Promise._flush();
        });
    });
}

type CursorIterator<T, I extends IDBCursor> = I extends IDBCursorWithValue ?
    (value: T, key: IDBValidKey, cursor: IDBCursorWithValue) => { done: boolean, jumpTo?: IDBValidKey } :
    (value: undefined, key: IDBValidKey, cursor: IDBCursor) => { done: boolean, jumpTo?: IDBValidKey }

export function iterateCursor<T, I extends IDBCursor = IDBCursorWithValue>(cursorRequest: IDBRequest<I | null>, processValue: CursorIterator<T, I>): Promise<boolean> {
    // TODO: does cursor already have a value here??
    return new Promise<boolean>((resolve, reject) => {
        cursorRequest.onerror = () => {
            reject(new IDBRequestError(cursorRequest));
            // @ts-ignore
            needsSyncPromise && Promise._flush && Promise._flush();
        };
        // collect results
        cursorRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<I>).result;
            if (!cursor) {
                resolve(false);
                // @ts-ignore
                needsSyncPromise && Promise._flush && Promise._flush();
                return; // end of results
            }
            const result = processValue(cursor["value"], cursor.key, cursor);
            // TODO: don't use object for result and assume it's jumpTo when not === true/false or undefined
            const done = result?.done;
            const jumpTo = result?.jumpTo;

            if (done) {
                resolve(true);
                // @ts-ignore
                needsSyncPromise && Promise._flush && Promise._flush();
            } else if(jumpTo) {
                cursor.continue(jumpTo);
            } else {
                cursor.continue();
            }
        };
    }).catch(err => {
        throw new StorageError("iterateCursor failed", err);
    });
}

type Pred<T> = (value: T) => boolean

export async function fetchResults<T>(cursor: IDBRequest, isDone: Pred<T[]>): Promise<T[]> {
    const results: T[] = [];
    await iterateCursor<T>(cursor, (value) => {
        results.push(value);
        return {done: isDone(results)};
    });
    return results;
}

type ToCursor = (store: IDBObjectStore) => IDBRequest

export async function select<T>(db: IDBDatabase, storeName: string, toCursor: ToCursor, isDone: Pred<T[]>): Promise<T[]> {
    if (!isDone) {
        isDone = () => false;
    }
    if (!toCursor) {
        toCursor = store => store.openCursor();
    }
    const tx = db.transaction([storeName], "readonly");
    const store = tx.objectStore(storeName);
    const cursor = toCursor(store);
    return await fetchResults(cursor, isDone);
}

export async function findStoreValue<T>(db: IDBDatabase, storeName: string, toCursor: ToCursor, matchesValue: Pred<T>): Promise<T> {
    if (!matchesValue) {
        matchesValue = () => true;
    }
    if (!toCursor) {
        toCursor = store => store.openCursor();
    }

    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);
    const cursor = await reqAsPromise(toCursor(store));
    let match;
    const matched = await iterateCursor<T>(cursor, (value) => {
        if (matchesValue(value)) {
            match = value;
            return { done: true };
        }
        return { done: false };
    });
    if (!matched) {
        throw new StorageError("Value not found");
    }
    return match;
}
