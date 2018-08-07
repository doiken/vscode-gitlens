'use strict';
import { Command, Disposable, ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';
import { GlyphChars } from '../../constants';
import { Container } from '../../container';
import { GitUri } from '../../gitService';
import { RefreshNodeCommandArgs } from '../explorerCommands';
import { GitExplorer } from '../gitExplorer';
import { HistoryExplorer } from '../historyExplorer';
import { ResultsExplorer } from '../resultsExplorer';

export interface NamedRef {
    label?: string;
    ref: string;
}

export enum RefreshReason {
    ActiveEditorChanged = 'active-editor-changed',
    AutoRefreshChanged = 'auto-refresh-changed',
    Command = 'command',
    ConfigurationChanged = 'configuration',
    NodeCommand = 'node-command',
    RepoChanged = 'repo-changed',
    ViewChanged = 'view-changed',
    VisibleEditorsChanged = 'visible-editors-changed'
}

export enum ResourceType {
    Branch = 'gitlens:branch',
    BranchWithTracking = 'gitlens:branch:tracking',
    Branches = 'gitlens:branches',
    BranchesWithRemotes = 'gitlens:branches:remotes',
    CurrentBranch = 'gitlens:branch:current',
    CurrentBranchWithTracking = 'gitlens:branch:current:tracking',
    RemoteBranch = 'gitlens:branch:remote',
    Commit = 'gitlens:commit',
    CommitOnCurrentBranch = 'gitlens:commit:current',
    CommitFile = 'gitlens:file:commit',
    Commits = 'gitlens:commits',
    ComparisonResults = 'gitlens:results:comparison',
    FileHistory = 'gitlens:history-file',
    Folder = 'gitlens:folder',
    History = 'gitlens:history',
    Message = 'gitlens:message',
    Pager = 'gitlens:pager',
    Remote = 'gitlens:remote',
    Remotes = 'gitlens:remotes',
    Repositories = 'gitlens:repositories',
    Repository = 'gitlens:repository',
    Results = 'gitlens:results',
    ResultsCommits = 'gitlens:results:commits',
    ResultsFiles = 'gitlens:results:files',
    SearchResults = 'gitlens:results:search',
    Stash = 'gitlens:stash',
    StashFile = 'gitlens:file:stash',
    Stashes = 'gitlens:stashes',
    StatusFile = 'gitlens:file:status',
    StatusFiles = 'gitlens:status:files',
    StatusFileCommits = 'gitlens:status:file-commits',
    StatusUpstream = 'gitlens:status:upstream',
    Tag = 'gitlens:tag',
    Tags = 'gitlens:tags'
}

export type Explorer = GitExplorer | HistoryExplorer | ResultsExplorer;

export abstract class ExplorerNode implements Disposable {
    readonly supportsPaging: boolean = false;
    maxCount: number | undefined;

    protected children: ExplorerNode[] | undefined;
    protected disposable: Disposable | undefined;

    constructor(
        public readonly uri: GitUri
    ) {}

    dispose() {
        if (this.disposable !== undefined) {
            this.disposable.dispose();
            this.disposable = undefined;
        }

        this.resetChildren();
    }

    abstract getChildren(): ExplorerNode[] | Promise<ExplorerNode[]>;
    abstract getTreeItem(): TreeItem | Promise<TreeItem>;

    getCommand(): Command | undefined {
        return undefined;
    }

    refresh(): void {}

    resetChildren(): void {
        if (this.children !== undefined) {
            this.children.forEach(c => c.dispose());
            this.children = undefined;
        }
    }
}

export abstract class ExplorerRefNode extends ExplorerNode {
    abstract get ref(): string;
    get repoPath(): string {
        return this.uri.repoPath!;
    }
}

export class MessageNode extends ExplorerNode {
    constructor(
        private readonly message: string,
        private readonly tooltip?: string,
        private readonly iconPath?:
            | string
            | Uri
            | {
                  light: string | Uri;
                  dark: string | Uri;
              }
            | ThemeIcon
    ) {
        super(new GitUri());
    }

    getChildren(): ExplorerNode[] | Promise<ExplorerNode[]> {
        return [];
    }

    getTreeItem(): TreeItem | Promise<TreeItem> {
        const item = new TreeItem(this.message, TreeItemCollapsibleState.None);
        item.contextValue = ResourceType.Message;
        item.tooltip = this.tooltip;
        item.iconPath = this.iconPath;
        return item;
    }
}

export abstract class PagerNode extends ExplorerNode {
    protected _args: RefreshNodeCommandArgs = {};

    constructor(
        protected readonly message: string,
        protected readonly node: ExplorerNode,
        protected readonly explorer: Explorer
    ) {
        super(new GitUri());
    }

    getChildren(): ExplorerNode[] | Promise<ExplorerNode[]> {
        return [];
    }

    getTreeItem(): TreeItem | Promise<TreeItem> {
        const item = new TreeItem(this.message, TreeItemCollapsibleState.None);
        item.contextValue = ResourceType.Pager;
        item.command = this.getCommand();
        item.iconPath = {
            dark: Container.context.asAbsolutePath('images/dark/icon-unfold.svg'),
            light: Container.context.asAbsolutePath('images/light/icon-unfold.svg')
        };
        return item;
    }

    getCommand(): Command | undefined {
        return {
            title: 'Refresh',
            command: this.explorer.getQualifiedCommand('refreshNode'),
            arguments: [this.node, this._args]
        } as Command;
    }
}

export class ShowMoreNode extends PagerNode {
    constructor(
        type: string,
        node: ExplorerNode,
        explorer: Explorer,
        maxCount: number = Container.config.advanced.maxListItems
    ) {
        super(
            maxCount === 0
                ? `Show All ${type} ${GlyphChars.Space}${GlyphChars.Dash}${GlyphChars.Space} this may take a while`
                : `Show More ${type}`,
            node,
            explorer
        );
        this._args.maxCount = maxCount;
    }
}

export class ShowAllNode extends ShowMoreNode {
    constructor(type: string, node: ExplorerNode, explorer: Explorer) {
        super(type, node, explorer, 0);
    }
}
