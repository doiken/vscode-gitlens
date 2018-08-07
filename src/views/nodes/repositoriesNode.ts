'use strict';
import { Disposable, TreeItem, TreeItemCollapsibleState, TreeViewVisibilityChangeEvent } from 'vscode';
import { Container } from '../../container';
import { GitUri } from '../../gitService';
import { Logger } from '../../logger';
import { GitExplorer } from '../gitExplorer';
import { ExplorerNode, MessageNode, ResourceType } from './explorerNode';
import { RepositoryNode } from './repositoryNode';

export class RepositoriesNode extends ExplorerNode {
    constructor(
        private readonly explorer: GitExplorer
    ) {
        super(undefined!);

        this.disposable = Disposable.from(
            this.explorer.onDidChangeAutoRefresh(this.onAutoRefreshChanged, this),
            this.explorer.onDidChangeVisibility(this.onVisibilityChanged, this)
        );
    }

    async getChildren(): Promise<ExplorerNode[]> {
        if (this.children === undefined) {
            const repositories = [...(await Container.git.getRepositories())];
            if (repositories.length === 0) return [new MessageNode('No repositories found')];

            const children = [];
            for (const repo of repositories.sort((a, b) => a.index - b.index)) {
                if (repo.closed) continue;

                children.push(
                    new RepositoryNode(GitUri.fromRepoPath(repo.path), repo, this.explorer)
                    // new MessageNode('')
                );
            }

            // children.splice(-1, 1);

            this.children = children;
        }

        return this.children;
    }

    async refresh() {
        if (this.children === undefined) return;

        const repositories = [...(await Container.git.getRepositories())];
        if (repositories.length === 0 && (this.children === undefined || this.children.length === 0)) return;

        if (repositories.length === 0) {
            this.children = [new MessageNode('No repositories found')];
            return;
        }

        const children = [];
        for (const repo of repositories.sort((a, b) => a.index - b.index)) {
            const normalizedPath = repo.normalizedPath;
            const child = (this.children as RepositoryNode[]).find(c => c.repo.normalizedPath === normalizedPath);
            if (child !== undefined) {
                children.push(child);
                child.refresh();
            }
            else {
                children.push(new RepositoryNode(GitUri.fromRepoPath(repo.path), repo, this.explorer));
            }
        }

        for (const child of this.children as RepositoryNode[]) {
            if (children.includes(child)) continue;

            child.dispose();
        }

        this.children = children;
        // this.resetChildren();
    }

    getTreeItem(): TreeItem {
        const item = new TreeItem(`Repositories`, TreeItemCollapsibleState.Expanded);
        item.contextValue = ResourceType.Repositories;
        return item;
    }

    private onAutoRefreshChanged() {
        // this.ensureSubscription();
    }

    onVisibilityChanged(e: TreeViewVisibilityChangeEvent) {
        Logger.log('onVisibilityChanged', e.visible);
    }
}
