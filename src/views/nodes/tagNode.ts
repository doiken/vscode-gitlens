'use strict';
import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import { ExplorerBranchesLayout } from '../../configuration';
import { Container } from '../../container';
import { GitTag, GitUri } from '../../gitService';
import { Iterables } from '../../system';
import { GitExplorer } from '../gitExplorer';
import { CommitNode } from './commitNode';
import { ExplorerNode, ExplorerRefNode, MessageNode, ResourceType, ShowMoreNode } from './explorerNode';

export class TagNode extends ExplorerRefNode {
    readonly supportsPaging: boolean = true;

    constructor(
        public readonly tag: GitTag,
        uri: GitUri,
        private readonly explorer: GitExplorer
    ) {
        super(uri);
    }

    get label(): string {
        return this.explorer.config.branches.layout === ExplorerBranchesLayout.Tree
            ? this.tag.getBasename()
            : this.tag.name;
    }

    get ref(): string {
        return this.tag.name;
    }

    async getChildren(): Promise<ExplorerNode[]> {
        const log = await Container.git.getLog(this.uri.repoPath!, {
            maxCount: this.maxCount || this.explorer.config.defaultItemLimit,
            ref: this.tag.name
        });
        if (log === undefined) return [new MessageNode('No commits yet')];

        const children: (CommitNode | ShowMoreNode)[] = [
            ...Iterables.map(log.commits.values(), c => new CommitNode(c, this.explorer))
        ];

        if (log.truncated) {
            children.push(new ShowMoreNode('Commits', this, this.explorer));
        }
        return children;
    }

    async getTreeItem(): Promise<TreeItem> {
        const item = new TreeItem(this.label, TreeItemCollapsibleState.Collapsed);
        item.tooltip = `${this.tag.name}${this.tag.annotation === undefined ? '' : `\n${this.tag.annotation}`}`;
        item.contextValue = ResourceType.Tag;
        return item;
    }
}
