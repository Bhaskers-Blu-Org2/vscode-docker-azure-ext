
import * as vscode from 'vscode';
import { DockerExtensionAPI, INodeBase } from './typings/docker-api';

export class NodeBase implements INodeBase{
    readonly label: string;

    protected constructor(label: string) {
        this.label = label;
    }

    getTreeItem(): vscode.TreeItem {
        return {
            label: this.label,
            collapsibleState: vscode.TreeItemCollapsibleState.None
        };
    }

    async getChildren(element): Promise<NodeBase[]> {
        return [];
    }
}