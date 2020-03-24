import { RequestResponse, CacheMode, RequestCreator, FetcherOptions } from './types';
import { KeyPrefixHelper } from './caches/utils';

function createAbortError(): RequestResponse<any> {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return { error };
}

export class FetcherRequest<T, R> {
    private cacheControl: CacheControl<T>;
    private response: Promise<RequestResponse<T>>;
    private isAborted = false;
    private abortController: AbortController;

    constructor(
        private cacheKey: string,
        private request: R,
        private requestCreator: RequestCreator<T, R>,
        private options: FetcherOptions<T>,
    ) {
        this.cacheControl = new CacheControl(options);
    }

    run(): Promise<RequestResponse<T>> {
        // return ongoing response
        if (this.response) {
            return this.response;
        }

        this.response = this.cacheControl.get(this.cacheKey).then(data => {
            if (this.isAborted) {
                return createAbortError();
            }
            const response: RequestResponse<T> = {
                data,
            };
            switch (this.options.cacheMode) {
                case CacheMode.OnlyIfCached:
                    // skip load from network for OnlyIfCached
                    break;
                case CacheMode.Default:
                case CacheMode.NoStore:
                case CacheMode.NoCache:
                case CacheMode.ForceCache:
                default:
                    // check if cache is fresh and send request if it's not
                    if (!this.cacheControl.isFresh(this.cacheKey)) {
                        if (typeof AbortController !== 'undefined') {
                            this.abortController = new AbortController();
                        }
                        const signal = this.abortController?.signal;

                        response.next = this.requestCreator(this.request, { signal })
                            .then(data => {
                                if (this.isAborted) {
                                    return createAbortError();
                                }
                                this.cacheControl.set(this.cacheKey, data);
                                return { data };
                            })
                            .catch(error => {
                                // TODO: retry?
                                return { error };
                            })
                            .then(res => {
                                // TODO: cleanup ?
                                return res;
                            });
                    }
                    break;
            }

            return response;
        });

        return this.response;
    }

    abort() {
        this.isAborted = true;
        this.abortController?.abort();
    }
}

class CacheControl<T> {
    private prefixHelper: KeyPrefixHelper;
    private timestampByKey = new Map<string, number>();
    constructor(private options: FetcherOptions<T>) {
        this.prefixHelper = new KeyPrefixHelper(options.cacheKeyPrefix ?? '');
    }

    isFresh(key: string): boolean {
        const timestamp = this.timestampByKey.get(key);
        if (!timestamp) {
            return false;
        }
        return Date.now() - timestamp < this.options.cacheMinFresh * 1000;
    }

    get(key: string): Promise<T | undefined> {
        switch (this.options.cacheMode) {
            case CacheMode.NoStore:
            case CacheMode.NoCache:
                return Promise.resolve(undefined);
            default:
                break;
        }

        return this.options.cache.get(this.prefixHelper.appendPrefix(key)).then(cachedData => {
            if (cachedData === undefined) {
                return undefined;
            }
            const { data, timestamp } = cachedData;
            if (!this.timestampByKey.has(key)) {
                this.timestampByKey.set(key, timestamp);
            }
            // check cache expires or not for default mode
            if (
                this.options.cacheMode === CacheMode.Default &&
                Date.now() - timestamp > this.options.cacheMaxAge * 1000
            ) {
                return undefined;
            }

            return data;
        });
    }

    set(key: string, value: T): Promise<void> {
        if (this.options.cacheMode === CacheMode.NoStore) {
            // skip cache for NoStore mode
            return Promise.resolve();
        }
        const timestamp = Date.now();
        this.timestampByKey.set(key, timestamp);
        return this.options.cache.set(this.prefixHelper.appendPrefix(key), {
            data: value,
            timestamp,
        });
    }
}
