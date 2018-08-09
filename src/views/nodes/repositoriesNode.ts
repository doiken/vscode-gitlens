'use strict';
import { Disposable, TreeItem, TreeItemCollapsibleState, TreeViewVisibilityChangeEvent } from 'vscode';
import { Container } from '../../container';
import { GitUri } from '../../gitService';
import { GitExplorer } from '../gitExplorer';
import { ExplorerNode, MessageNode, ResourceType } from './explorerNode';
import { RepositoryNode } from './repositoryNode';

export class RepositoriesNode extends ExplorerNode implements Disposable {
    private _children: (RepositoryNode | MessageNode)[] | undefined;
    private _disposable: Disposable | undefined;
    private _repositoriesChangedDisposable: Disposable | undefined;

    constructor(
        private readonly explorer: GitExplorer
    ) {
        super(undefined!);

        this._disposable = Disposable.from(
            this.explorer.onDidChangeAutoRefresh(this.onAutoRefreshChanged, this),
            this.explorer.onDidChangeVisibility(this.onVisibilityChanged, this)
        );
    }

    dispose() {
        if (this._repositoriesChangedDisposable !== undefined) {
            this._repositoriesChangedDisposable.dispose();
            this._repositoriesChangedDisposable = undefined;
        }

        if (this._disposable !== undefined) {
            this._disposable.dispose();
            this._disposable = undefined;
        }

        if (this._children !== undefined) {
            for (const child of this._children) {
                if (child instanceof RepositoryNode) {
                    child.dispose();
                }
            }
            this._children = undefined;
        }
    }

    async getChildren(): Promise<ExplorerNode[]> {
        if (this._children === undefined) {
            const repositories = [...(await Container.git.getRepositories())];
            if (repositories.length === 0) return [new MessageNode('No repositories found')];

            const compact = false; // TODO: Add setting

            const children = [];
            for (const repo of repositories.sort((a, b) => a.index - b.index)) {
                if (repo.closed) continue;

                children.push(new RepositoryNode(GitUri.fromRepoPath(repo.path), repo, this.explorer));

                if (compact) {
                    children.push(new MessageNode(''));
                }
            }

            if (!compact) {
                children.splice(-1, 1);
            }

            this._children = children;
        }

        return this._children;
    }

    async refresh() {
        if (this._children === undefined) return;

        const repositories = [...(await Container.git.getRepositories())];
        if (repositories.length === 0 && (this._children === undefined || this._children.length === 0)) return;

        if (repositories.length === 0) {
            this._children = [new MessageNode('No repositories found')];
            return;
        }

        const children = [];
        for (const repo of repositories.sort((a, b) => a.index - b.index)) {
            const normalizedPath = repo.normalizedPath;
            const child = (this._children as RepositoryNode[]).find(c => c.repo.normalizedPath === normalizedPath);
            if (child !== undefined) {
                children.push(child);
                child.refresh();
            }
            else {
                children.push(new RepositoryNode(GitUri.fromRepoPath(repo.path), repo, this.explorer));
            }
        }

        for (const child of this._children as RepositoryNode[]) {
            if (children.includes(child)) continue;

            child.dispose();
        }

        this._children = children;
        this.ensureSubscription();
    }

    getTreeItem(): TreeItem {
        const item = new TreeItem(`Repositories`, TreeItemCollapsibleState.Expanded);
        item.contextValue = ResourceType.Repositories;

        this.ensureSubscription();

        return item;
    }

    private onAutoRefreshChanged() {
        this.ensureSubscription();

        if (this._children === undefined) return;

        for (const child of this._children) {
            if (child instanceof RepositoryNode) {
                child.ensureSubscription();
            }
        }
    }

    private onRepositoriesChanged() {
        this.explorer.refreshNode(this);
    }

    onVisibilityChanged(e: TreeViewVisibilityChangeEvent) {
        if (this._children === undefined) return;
        if (!this.explorer.autoRefresh) return;

        this.ensureSubscription();
        for (const child of this._children) {
            if (child instanceof RepositoryNode) {
                if (e.visible) {
                    this.explorer.refreshNode(child);
                }
                else {
                    child.ensureSubscription();
                }
            }
        }
    }

    private ensureSubscription() {
        // We only need to subscribe if auto-refresh is enabled and we are visible
        if (!this.explorer.autoRefresh || !this.explorer.visible) {
            if (this._repositoriesChangedDisposable !== undefined) {
                this._repositoriesChangedDisposable.dispose();
                this._repositoriesChangedDisposable = undefined;
            }

            return;
        }

        // If we already have a subscription, just kick out
        if (this._repositoriesChangedDisposable !== undefined) return;

        this._repositoriesChangedDisposable = Disposable.from(
            Container.git.onDidChangeRepositories(this.onRepositoriesChanged, this)
        );
    }
}
