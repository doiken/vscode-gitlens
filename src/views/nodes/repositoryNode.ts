'use strict';
import { Disposable, TreeItem, TreeItemCollapsibleState, TreeViewVisibilityChangeEvent } from 'vscode';
import { GlyphChars } from '../../constants';
import { Container } from '../../container';
import { GitBranch, GitStatus, RepositoryFileSystemChangeEvent } from '../../git/git';
import { GitUri, Repository, RepositoryChange, RepositoryChangeEvent } from '../../gitService';
import { Logger } from '../../logger';
import { Strings } from '../../system';
import { GitExplorer } from '../gitExplorer';
import { BranchesNode } from './branchesNode';
import { BranchNode } from './branchNode';
import { ExplorerNode, MessageNode, ResourceType } from './explorerNode';
import { RemotesNode } from './remotesNode';
import { StashesNode } from './stashesNode';
import { StatusFilesNode } from './statusFilesNode';
import { StatusUpstreamNode } from './statusUpstreamNode';
import { TagsNode } from './tagsNode';

export class RepositoryNode extends ExplorerNode {
    private _status: Promise<GitStatus | undefined>;

    constructor(
        uri: GitUri,
        public readonly repo: Repository,
        private readonly explorer: GitExplorer,
        private readonly active: boolean = false,
        private readonly activeParent?: ExplorerNode
    ) {
        super(uri);

        this._status = this.repo.getStatus();
    }

    get id(): string {
        return `gitlens:repository(${this.repo.path})${this.active ? ':active' : ''}`;
    }

    async getChildren(): Promise<ExplorerNode[]> {
        if (this.children === undefined) {
            this.ensureSubscription();

            const children = [];

            const status = await this._status;
            if (status !== undefined) {
                const branch = new GitBranch(
                    status.repoPath,
                    status.branch,
                    true,
                    status.sha,
                    status.upstream,
                    status.state.ahead,
                    status.state.behind
                );
                children.push(new BranchNode(branch, this.uri, this.explorer, false));

                if (status.state.behind) {
                    children.push(new StatusUpstreamNode(status, 'behind', this.explorer, this.active));
                }

                if (status.state.ahead) {
                    children.push(new StatusUpstreamNode(status, 'ahead', this.explorer, this.active));
                }

                if (status.state.ahead || (status.files.length !== 0 && this.includeWorkingTree)) {
                    const range = status.upstream ? `${status.upstream}..${status.branch}` : undefined;
                    children.push(new StatusFilesNode(status, range, this.explorer, this.active));
                }

                children.push(new MessageNode(GlyphChars.Dash.repeat(2), ''));
            }

            children.push(
                new BranchesNode(this.uri, this.repo, this.explorer, this.active),
                new RemotesNode(this.uri, this.repo, this.explorer, this.active),
                new StashesNode(this.uri, this.repo, this.explorer, this.active),
                new TagsNode(this.uri, this.repo, this.explorer, this.active)
            );
            this.children = children;
        }
        return this.children;
    }

    async getTreeItem(): Promise<TreeItem> {
        this.ensureSubscription();

        let label = `${this.active ? `Active Repository ${Strings.pad(GlyphChars.Dash, 1, 1)} ` : ''}${this.repo
            .formattedName || this.uri.repoPath}`;

        let tooltip = this.repo.formattedName ? `${this.repo.formattedName}\n${this.uri.repoPath}` : this.uri.repoPath;
        let iconSuffix = '';
        let workingStatus = '';

        const status = await this._status;
        if (status !== undefined) {
            tooltip += `\n\n${status.branch}`;

            if (status.files.length !== 0 && this.includeWorkingTree) {
                workingStatus = status.getDiffStatus({
                    prefix: Strings.pad(GlyphChars.Dot, 2, 2)
                });
            }

            const upstreamStatus = status.getUpstreamStatus({
                prefix: `${GlyphChars.Space} `
            });

            label += ` ${Strings.pad(GlyphChars.Dash, 2, 3)}${status.branch}${upstreamStatus}${workingStatus}`;

            iconSuffix = workingStatus ? '-blue' : '';
            if (status.upstream !== undefined) {
                tooltip += ` is tracking ${status.upstream}\n${status.getUpstreamStatus({
                    empty: 'up-to-date',
                    expand: true,
                    separator: '\n',
                    suffix: '\n'
                })}`;

                if (status.state.behind) {
                    iconSuffix = '-red';
                }
                if (status.state.ahead) {
                    iconSuffix = status.state.behind ? '-yellow' : '-green';
                }
            }

            if (workingStatus) {
                tooltip += `\nWorking tree has uncommitted changes${status.getDiffStatus({
                    expand: true,
                    prefix: `\n`,
                    separator: '\n'
                })}`;
            }
        }

        const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
        item.id = this.id;
        item.contextValue = ResourceType.Repository;
        item.tooltip = tooltip;
        item.iconPath = {
            dark: Container.context.asAbsolutePath(`images/dark/icon-repo${iconSuffix}.svg`),
            light: Container.context.asAbsolutePath(`images/light/icon-repo${iconSuffix}.svg`)
        };
        return item;
    }

    refresh() {
        this._status = this.repo.getStatus();

        this.resetChildren();
        this.ensureSubscription();
    }

    private get includeWorkingTree(): boolean {
        return this.explorer.config.includeWorkingTree;
    }

    private ensureSubscription() {
        // We only need to subscribe if auto-refresh is enabled, because if it becomes enabled we will be refreshed
        if (!this.explorer.autoRefresh) {
            if (this.disposable !== undefined) {
                this.disposable.dispose();
                this.disposable = undefined;
            }

            return;
        }

        // If we have a previous subscription, just kick out
        if (this.disposable !== undefined) return;

        const disposables = [
            // TODO: Move to RepositoriesNode
            this.explorer.onDidChangeAutoRefresh(this.onAutoRefreshChanged, this),
            // TODO: Move to RepositoriesNode
            this.explorer.onDidChangeVisibility(this.onVisibilityChanged, this),
            this.repo.onDidChange(this.onRepoChanged, this)
        ];

        if (this.includeWorkingTree) {
            disposables.push(this.repo.onDidChangeFileSystem(this.onFileSystemChanged, this), {
                dispose: () => this.repo.stopWatchingFileSystem()
            });

            this.repo.startWatchingFileSystem();
        }

        this.disposable = Disposable.from(...disposables);
    }

    private onAutoRefreshChanged() {
        this.ensureSubscription();
    }

    private async onFileSystemChanged(e: RepositoryFileSystemChangeEvent) {
        this.explorer.refreshNode(this);
    }

    private onRepoChanged(e: RepositoryChangeEvent) {
        Logger.log(`RepositoryNode.onRepoChanged(${e.changes.join()}); triggering node refresh`);

        if (e.changed(RepositoryChange.Closed)) {
            this.dispose();

            return;
        }

        if (
            this.children === undefined ||
            e.changed(RepositoryChange.Repository) ||
            e.changed(RepositoryChange.Config)
        ) {
            this.explorer.refreshNode(this.active && this.activeParent !== undefined ? this.activeParent : this);

            return;
        }

        if (e.changed(RepositoryChange.Stashes)) {
            const node = this.children.find(c => c instanceof StashesNode);
            if (node !== undefined) {
                this.explorer.refreshNode(node);
            }
        }

        if (e.changed(RepositoryChange.Remotes)) {
            const node = this.children.find(c => c instanceof RemotesNode);
            if (node !== undefined) {
                this.explorer.refreshNode(node);
            }
        }

        if (e.changed(RepositoryChange.Tags)) {
            const node = this.children.find(c => c instanceof TagsNode);
            if (node !== undefined) {
                this.explorer.refreshNode(node);
            }
        }
    }

    onVisibilityChanged(e: TreeViewVisibilityChangeEvent) {
        Logger.log('onVisibilityChanged', e.visible);
    }
}
