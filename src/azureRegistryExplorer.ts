import * as vscode from 'vscode';
import * as path from 'path';
import * as moment from 'moment';
import * as request from 'request-promise';
import * as ContainerModels from '../node_modules/azure-arm-containerregistry/lib/models';
import * as keytarType from 'keytar';

import { NodeBase } from './nodeBase';
import { SubscriptionClient, ResourceManagementClient, SubscriptionModels } from 'azure-arm-resource';
import { AzureAccount, AzureSession } from './typings/azure-account.api';
import { ServiceClientCredentials } from 'ms-rest';
import { IRegistryRootNode, INodeBase } from './typings/docker-api';

const ContainerRegistryManagement = require('azure-arm-containerregistry');

export class AzureRootNode implements IRegistryRootNode {

    private _keytar: typeof keytarType;
    public eventEmitter: vscode.EventEmitter<NodeBase> = new vscode.EventEmitter<NodeBase>();

    constructor(
        public readonly label: string,
        public readonly contextValue: string,
        public readonly azureAccount?: AzureAccount
    ) {
        try {
            this._keytar = require(`${vscode.env.appRoot}/node_modules/keytar`);
        } catch (e) {
            // unable to find keytar
        }

        this.azureAccount.onFiltersChanged((e) => {
            this.eventEmitter.fire(this);
        });
        this.azureAccount.onStatusChanged((e) => {
            this.eventEmitter.fire(this);
        });
        this.azureAccount.onSessionsChanged((e) => {
            this.eventEmitter.fire(this);
        });
    }

    refresh(): void {
         this.eventEmitter.fire(this);
    }

    getTreeItem(): vscode.TreeItem {
        return {
            label: this.label,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            contextValue: this.contextValue
        }
    }

    async getChildren(element?: NodeBase): Promise<NodeBase[]> {
        return this.getAzureRegistries();
    }

    private async getAzureRegistries(): Promise<AzureRegistryNode[] | AzureLoadingNode[] | AzureNotSignedInNode[]> {

        if (!this.azureAccount) {
            return [];
        }

        const loggedIntoAzure: boolean = await this.azureAccount.waitForLogin()
        const azureRegistryNodes: AzureRegistryNode[] = [];

        if (this.azureAccount.status === 'Initializing' || this.azureAccount.status === 'LoggingIn') {
            return [new AzureLoadingNode()];
        }

        if (this.azureAccount.status === 'LoggedOut') {
            return [new AzureNotSignedInNode()];
        }

        if (loggedIntoAzure) {

            const subs: SubscriptionModels.Subscription[] = this.getFilteredSubscriptions();

            for (let i = 0; i < subs.length; i++) {

                const client = new ContainerRegistryManagement(this.getCredentialByTenantId(subs[i].tenantId), subs[i].subscriptionId);
                const registries: ContainerModels.RegistryListResult = await client.registries.list();

                for (let j = 0; j < registries.length; j++) {

                    if (registries[j].adminUserEnabled && registries[j].sku.tier.includes('Managed')) {
                        const resourceGroup: string = registries[j].id.slice(registries[j].id.search('resourceGroups/') + 'resourceGroups/'.length, registries[j].id.search('/providers/'));
                        const creds: ContainerModels.RegistryListCredentialsResult = await client.registries.listCredentials(resourceGroup, registries[j].name);

                        let iconPath = {
                            light: path.join(__filename, '..', '..', 'images', 'light', 'Registry_16x.svg'),
                            dark: path.join(__filename, '..', '..', 'images', 'dark', 'Registry_16x.svg')
                        };
                        let node = new AzureRegistryNode(registries[j].loginServer, 'azureRegistryNode', iconPath, this.azureAccount);
                        // node.type = RegistryType.Azure;
                        node.password = creds.passwords[0].value;
                        node.userName = creds.username;
                        node.subscription = subs[i];
                        node.registry = registries[j];
                        azureRegistryNodes.push(node);
                    }
                }
            }
        }

        return azureRegistryNodes;
    }

    private getCredentialByTenantId(tenantId: string): ServiceClientCredentials {

        const session = this.azureAccount.sessions.find((s, i, array) => s.tenantId.toLowerCase() === tenantId.toLowerCase());

        if (session) {
            return session.credentials;
        }

        throw new Error(`Failed to get credentials, tenant ${tenantId} not found.`);
    }

    private getFilteredSubscriptions(): SubscriptionModels.Subscription[] {

        if (this.azureAccount) {
            return this.azureAccount.filters.map<SubscriptionModels.Subscription>(filter => {
                return {
                    id: filter.subscription.id,
                    session: filter.session,
                    subscriptionId: filter.subscription.subscriptionId,
                    tenantId: filter.session.tenantId,
                    displayName: filter.subscription.displayName,
                    state: filter.subscription.state,
                    subscriptionPolicies: filter.subscription.subscriptionPolicies,
                    authorizationSource: filter.subscription.authorizationSource
                };
            });
        } else {
            return [];
        }
    }

}


export class AzureRegistryNode extends NodeBase {
    private _azureAccount: AzureAccount;

    constructor(
        public readonly label: string,
        public readonly contextValue: string,
        public readonly iconPath: any = {},
        public readonly azureAccount?: AzureAccount
    ) {
        super(label);
        this._azureAccount = azureAccount;
    }

    public password: string;
    public registry: ContainerModels.Registry;
    public subscription: SubscriptionModels.Subscription;
    // public type: RegistryType;
    public userName: string;

    getTreeItem(): vscode.TreeItem {
        return {
            label: this.label,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            contextValue: this.contextValue,
            iconPath: this.iconPath
        }
    }

    async getChildren(element: AzureRegistryNode): Promise<AzureRepositoryNode[]> {
        const repoNodes: AzureRepositoryNode[] = [];
        let node: AzureRepositoryNode;

        const tenantId: string = element.subscription.tenantId;
        if (!this._azureAccount) {
            return [];
        }

        const session: AzureSession = this._azureAccount.sessions.find((s, i, array) => s.tenantId.toLowerCase() === tenantId.toLowerCase());
        const { accessToken, refreshToken } = await acquireToken(session);

        if (accessToken && refreshToken) {
            let refreshTokenARC;
            let accessTokenARC;

            await request.post('https://' + element.label + '/oauth2/exchange', {
                form: {
                    grant_type: 'access_token_refresh_token',
                    service: element.label,
                    tenant: tenantId,
                    refresh_token: refreshToken,
                    access_token: accessToken
                }
            }, (err, httpResponse, body) => {
                if (body.length > 0) {
                    refreshTokenARC = JSON.parse(body).refresh_token;
                } else {
                    return [];
                }
            });

            await request.post('https://' + element.label + '/oauth2/token', {
                form: {
                    grant_type: 'refresh_token',
                    service: element.label,
                    scope: 'registry:catalog:*',
                    refresh_token: refreshTokenARC
                }
            }, (err, httpResponse, body) => {
                if (body.length > 0) {
                    accessTokenARC = JSON.parse(body).access_token;
                } else {
                    return [];
                }
            });

            await request.get('https://' + element.label + '/v2/_catalog', {
                auth: {
                    bearer: accessTokenARC
                }
            }, (err, httpResponse, body) => {
                if (body.length > 0) {
                    const repositories = JSON.parse(body).repositories;
                    for (let i = 0; i < repositories.length; i++) {
                        node = new AzureRepositoryNode(repositories[i], "azureRepositoryNode");
                        node.accessTokenARC = accessTokenARC;
                        node.azureAccount = element.azureAccount;
                        node.password = element.password;
                        node.refreshTokenARC = refreshTokenARC;
                        node.registry = element.registry;
                        node.repository = element.label;
                        node.subscription = element.subscription;
                        node.userName = element.userName;
                        repoNodes.push(node);
                    }
                }
            });
        }

        return repoNodes;
    }
}



export class AzureRepositoryNode extends NodeBase {

    constructor(
        public readonly label: string,
        public readonly contextValue: string,
        public readonly iconPath = {
            light: path.join(__filename, '..', '..', 'images', 'light', 'Repository_16x.svg'),
            dark: path.join(__filename, '..', '..', 'images', 'dark', 'Repository_16x.svg')
        }
    ) {
        super(label);
    }

    public accessTokenARC: string;
    public azureAccount: AzureAccount
    public password: string;
    public refreshTokenARC: string;
    public registry: ContainerModels.Registry;
    public repository: string;
    public subscription: SubscriptionModels.Subscription;
    public userName: string;

    getTreeItem(): vscode.TreeItem {
        return {
            label: this.label,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            contextValue: this.contextValue,
            iconPath: this.iconPath
        }
    }

    async getChildren(element: AzureRepositoryNode): Promise<AzureImageNode[]> {
        const imageNodes: AzureImageNode[] = [];
        let node: AzureImageNode;
        let created: string = '';
        let refreshTokenARC;
        let accessTokenARC;
        let tags;

        const tenantId: string = element.subscription.tenantId;
        const session: AzureSession = element.azureAccount.sessions.find((s, i, array) => s.tenantId.toLowerCase() === tenantId.toLowerCase());
        const { accessToken, refreshToken } = await acquireToken(session);

        if (accessToken && refreshToken) {
            const tenantId = element.subscription.tenantId;

            await request.post('https://' + element.repository + '/oauth2/exchange', {
                form: {
                    grant_type: 'access_token_refresh_token',
                    service: element.repository,
                    tenant: tenantId,
                    refresh_token: refreshToken,
                    access_token: accessToken
                }
            }, (err, httpResponse, body) => {
                if (body.length > 0) {
                    refreshTokenARC = JSON.parse(body).refresh_token;
                } else {
                    return [];
                }
            });

            await request.post('https://' + element.repository + '/oauth2/token', {
                form: {
                    grant_type: 'refresh_token',
                    service: element.repository,
                    scope: 'repository:' + element.label + ':pull',
                    refresh_token: refreshTokenARC
                }
            }, (err, httpResponse, body) => {
                if (body.length > 0) {
                    accessTokenARC = JSON.parse(body).access_token;
                } else {
                    return [];
                }
            });

            await request.get('https://' + element.repository + '/v2/' + element.label + '/tags/list', {
                auth: {
                    bearer: accessTokenARC
                }
            }, (err, httpResponse, body) => {
                if (err) { return []; }
                if (body.length > 0) {
                    tags = JSON.parse(body).tags;
                }
            });

            for (let i = 0; i < tags.length; i++) {
                created = '';
                let manifest = JSON.parse(await request.get('https://' + element.repository + '/v2/' + element.label + '/manifests/latest', {
                    auth: { bearer: accessTokenARC }
                }));
                created = moment(new Date(JSON.parse(manifest.history[0].v1Compatibility).created)).fromNow();

                node = new AzureImageNode(`${element.label}:${tags[i]} (${created})`, 'azureImageNode');
                node.azureAccount = element.azureAccount;
                node.password = element.password;
                node.registry = element.registry;
                node.serverUrl = element.repository;
                node.subscription = element.subscription;
                node.userName = element.userName;
                imageNodes.push(node);

            }

        }
        return imageNodes;
    }
}

export class AzureImageNode extends NodeBase {
    constructor(
        public readonly label: string,
        public readonly contextValue: string
    ) {
        super(label);
    }

    public azureAccount: AzureAccount
    public password: string;
    public registry: ContainerModels.Registry;
    public serverUrl: string;
    public subscription: SubscriptionModels.Subscription;
    public userName: string;

    getTreeItem(): vscode.TreeItem {
        return {
            label: this.label,
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: this.contextValue
        }
    }
}

export class AzureNotSignedInNode extends NodeBase {
    constructor() {
        super('Sign in to Azure...');
    }

    getTreeItem(): vscode.TreeItem {
        return {
            label: this.label,
            command: {
                title: this.label,
                command: 'azure-account.login'
            },
            collapsibleState: vscode.TreeItemCollapsibleState.None
        }
    }
}

export class AzureLoadingNode extends NodeBase {
    constructor() {
        super('Loading...');
    }

    getTreeItem(): vscode.TreeItem {
        return {
            label: this.label,
            collapsibleState: vscode.TreeItemCollapsibleState.None
        }
    }
}

async function acquireToken(session: AzureSession) {
    return new Promise<{ accessToken: string; refreshToken: string; }>((resolve, reject) => {
        const credentials: any = session.credentials;
        const environment: any = session.environment;
        credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
            if (err) {
                reject(err);
            } else {
                resolve({
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken
                });
            }
        });
    });
}

