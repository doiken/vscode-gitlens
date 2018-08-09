'use strict';
import { Disposable, TreeItem, TreeItemCollapsibleState } from 'vscode';
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

export class RepositoryNode extends ExplorerNode implements Disposable {
    private _children: ExplorerNode[] | undefined;
    private _disposable: Disposable | undefined;
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

    dispose() {
        if (this._disposable !== undefined) {
            this._disposable.dispose();
            this._disposable = undefined;
        }
    }

    get id(): string {
        return `gitlens:repository(${this.repo.path})${this.active ? ':active' : ''}`;
    }

    async getChildren(): Promise<ExplorerNode[]> {
        if (this._children === undefined) {
            const compact = false; // TODO: Add setting

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

                if (!compact) {
                    children.push(new MessageNode(GlyphChars.Dash.repeat(2), ''));
                }
            }

            children.push(
                new BranchesNode(this.uri, this.repo, this.explorer, this.active),
                new RemotesNode(this.uri, this.repo, this.explorer, this.active),
                new StashesNode(this.uri, this.repo, this.explorer, this.active),
                new TagsNode(this.uri, this.repo, this.explorer, this.active)
            );
            this._children = children;
        }
        return this._children;
    }

    async getTreeItem(): Promise<TreeItem> {
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

        this.ensureSubscription();

        return item;
    }

    refresh() {
        this._status = this.repo.getStatus();

        this._children = undefined;
        this.ensureSubscription();
    }

    private get includeWorkingTree(): boolean {
        return this.explorer.config.includeWorkingTree;
    }

    ensureSubscription() {
        // We only need to subscribe if auto-refresh is enabled and we are visible
        if (!this.explorer.autoRefresh || !this.explorer.visible) {
            if (this._disposable !== undefined) {
                this._disposable.dispose();
                this._disposable = undefined;
            }

            return;
        }

        // If we already have a subscription, just kick out
        if (this._disposable !== undefined) return;

        const disposables = [this.repo.onDidChange(this.onRepoChanged, this)];

        if (this.includeWorkingTree) {
            disposables.push(this.repo.onDidChangeFileSystem(this.onFileSystemChanged, this), {
                dispose: () => this.repo.stopWatchingFileSystem()
            });

            this.repo.startWatchingFileSystem();
        }

        this._disposable = Disposable.from(...disposables);
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
            this._children === undefined ||
            e.changed(RepositoryChange.Repository) ||
            e.changed(RepositoryChange.Config)
        ) {
            this.explorer.refreshNode(this.active && this.activeParent !== undefined ? this.activeParent : this);

            return;
        }

        if (e.changed(RepositoryChange.Stashes)) {
            const node = this._children.find(c => c instanceof StashesNode);
            if (node !== undefined) {
                this.explorer.refreshNode(node);
            }
        }

        if (e.changed(RepositoryChange.Remotes)) {
            const node = this._children.find(c => c instanceof RemotesNode);
            if (node !== undefined) {
                this.explorer.refreshNode(node);
            }
        }

        if (e.changed(RepositoryChange.Tags)) {
            const node = this._children.find(c => c instanceof TagsNode);
            if (node !== undefined) {
                this.explorer.refreshNode(node);
            }
        }
    }
}
