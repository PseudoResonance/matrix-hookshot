
import axios from 'axios';
import JiraApi, { SearchUserOptions } from 'jira-client';
import QuickLRU from "@alloc/quick-lru";
import { JiraAccount, JiraAPIAccessibleResource, JiraIssue, JiraOAuthResult, JiraProject } from './Types';
import { BridgeConfigJira } from '../Config/Config';
import LogWrapper from '../LogWrapper';

const log = new LogWrapper("JiraClient");
const ACCESSIBLE_RESOURCE_CACHE_LIMIT = 100;
const ACCESSIBLE_RESOURCE_CACHE_TTL_MS = 60000;

export class HookshotJiraApi extends JiraApi {
    constructor(private options: JiraApi.JiraApiOptions) {
        super(options);
    }

    async getProject(projectIdOrKey: string): Promise<JiraProject> {
        return await super.getProject(projectIdOrKey) as JiraProject;
    }

    async getIssue(issueIdOrKey: string): Promise<JiraIssue> {
        const res = await axios.get<JiraIssue>(`https://api.atlassian.com/${this.options.base}/rest/api/3/issue/${issueIdOrKey}`, {
            headers: {
                Authorization: `Bearer ${this.options.bearer}`
            },
            responseType: 'json',
        });
        return res.data;
    }

    async searchUsers(opts: SearchUserOptions): Promise<JiraAccount[]> {
        return super.searchUsers(opts) as unknown as JiraAccount[];
    }
}

export class JiraClient {

    /**
     * Cache of accessible resources for a user.
     */
    static resourceCache = new QuickLRU<string, Promise<JiraAPIAccessibleResource[]>>({
        maxSize: ACCESSIBLE_RESOURCE_CACHE_LIMIT,
        maxAge: ACCESSIBLE_RESOURCE_CACHE_TTL_MS
    });

    constructor(private oauth2State: JiraOAuthResult, private readonly onTokenRefreshed: (newData: JiraOAuthResult) => Promise<void>, private readonly config: BridgeConfigJira) {

    }

    private get bearer() {
        return this.oauth2State.access_token;
    }

    async getAccessibleResources() {
        try {
            const existingPromise = JiraClient.resourceCache.get(this.bearer);
            if (existingPromise) {
                return await existingPromise;
            }
        } catch (ex) {
            // Existing failed promise, break out and try again.
            JiraClient.resourceCache.delete(this.bearer);
        }
        await this.checkTokenAge();
        const promise = (async () => {
            const res = await axios.get(`https://api.atlassian.com/oauth/token/accessible-resources`, {
                headers: {
                    Authorization: `Bearer ${this.bearer}`
                },
                responseType: 'json',
            });
            return res.data as JiraAPIAccessibleResource[];
        })();
        JiraClient.resourceCache.set(this.bearer, promise);
        return promise;
    }

    async checkTokenAge() {
        if (this.oauth2State.expires_in + 60000 > Date.now()) {
            return;
        }
        log.info(`Refreshing oauth token`);
        // Refresh the token
        const res = await axios.post(`https://api.atlassian.com/oauth/token`, {
            grant_type: "refresh_token",
            client_id: this.config.oauth.client_id,
            client_secret: this.config.oauth.client_secret,
            refresh_token: this.oauth2State.refresh_token,
        });
        const data = res.data as JiraOAuthResult;
        data.expires_in += Date.now() + (data.expires_in * 1000);
        this.oauth2State = data;
        this.onTokenRefreshed(this.oauth2State);
    }

    async getClientForUrl(url: URL) {
        const resource = (await this.getAccessibleResources()).find((r) => new URL(r.url).origin === url.origin);
        if (!resource) {
            return null;
        } 
        return this.getClientForResource(resource);
    }

    async getClientForResource(res: JiraAPIAccessibleResource) {
        // Check token age
        await this.checkTokenAge();
        return new HookshotJiraApi({
            protocol: 'https',
            host: `api.atlassian.com`,
            base: `/ex/jira/${res.id}`,
            apiVersion: '3',
            strictSSL: true,
            bearer: this.bearer,
        });
    }
}