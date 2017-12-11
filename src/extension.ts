'use strict';
import * as vscode from 'vscode';
import * as opn from 'opn';
import { AzureAccount } from './typings/azure-account.api';
import { browseAzurePortal } from './azureUtils';
import { WebAppCreator } from './deploy/webAppCreator';
import { AzureImageNode, AzureRegistryNode, AzureRepositoryNode } from './azureRegistryExplorer';
import { AzureAccountWrapper } from './deploy/azureAccountWrapper';
import * as util from "./deploy/util";

import { AzureRootNode } from './azureRegistryExplorer';
import { DockerExtensionAPI, INodeBase, IExplorerRegistryProvider, IRegistryRootNode } from './typings/docker-api';

export var azureRegistryNode: AzureRootNode;

export async function activate(context: vscode.ExtensionContext) {

    const dockerExplorer = <DockerExtensionAPI>vscode.extensions.getExtension('PeterJausovec.vscode-docker').exports;
    const azureAccount = <AzureAccount>vscode.extensions.getExtension('ms-vscode.azure-account').exports;

    const azureRootNode = new AzureRootNode('Azure', 'azureRegistryRootNode', azureAccount);
    const outputChannel = util.getOutputChannel();

    dockerExplorer.registerExplorerRegistryProvider(new class implements IExplorerRegistryProvider {
        onDidChangeTreeData: vscode.Event<INodeBase> = azureRootNode.eventEmitter.event;
        getRootNode(): Promise<IRegistryRootNode> {
            return Promise.resolve(azureRootNode);
        }
    });

    // context.subscriptions.push(vscode.commands.registerCommand('vscode-docker.createWebApp', async (context?: AzureImageNode | DockerHubImageNode) => {
    context.subscriptions.push(vscode.commands.registerCommand('vscode-docker.createWebApp', async (context?: AzureImageNode | any) => {
        if (context && azureAccount) {
            const azureAccountWrapper = new AzureAccountWrapper(context, azureAccount);
            const wizard = new WebAppCreator(outputChannel, azureAccountWrapper, context);
            const result = await wizard.run();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vscode-docker.browseAzurePortal', async (context?: AzureRegistryNode | AzureRepositoryNode | AzureImageNode) => {
        browseAzurePortal(context);
    }));


}

export function deactivate() {
}