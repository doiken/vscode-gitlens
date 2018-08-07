'use strict';
import {
    commands,
    ConfigurationChangeEvent,
    Disposable,
    Event,
    EventEmitter,
    TextDocumentShowOptions,
    TreeDataProvider,
    TreeItem,
    TreeView,
    TreeViewVisibilityChangeEvent,
    Uri,
    window
} from 'vscode';
import { configuration, ExplorerFilesLayout, IExplorersConfig, IGitExplorerConfig } from '../configuration';
import { CommandContext, setCommandContext, WorkspaceState } from '../constants';
import { Container } from '../container';
import { Logger } from '../logger';
import { RefreshNodeCommandArgs } from '../views/explorerCommands';
import { ExplorerNode, MessageNode, RefreshReason, RepositoriesNode } from './nodes';

export * from './nodes';

export interface OpenFileRevisionCommandArgs {
    uri?: Uri;
    showOptions?: TextDocumentShowOptions;
}

export class GitExplorer implements TreeDataProvider<ExplorerNode>, Disposable {
    private _disposable: Disposable | undefined;
    private _root?: ExplorerNode;
    private _tree: TreeView<ExplorerNode> | undefined;

    private _onDidChangeAutoRefresh = new EventEmitter<void>();
    public get onDidChangeAutoRefresh(): Event<void> {
        return this._onDidChangeAutoRefresh.event;
    }

    private _onDidChangeTreeData = new EventEmitter<ExplorerNode>();
    public get onDidChangeTreeData(): Event<ExplorerNode> {
        return this._onDidChangeTreeData.event;
    }

    private _onDidChangeVisibility = new EventEmitter<TreeViewVisibilityChangeEvent>();
    public get onDidChangeVisibility(): Event<TreeViewVisibilityChangeEvent> {
        return this._onDidChangeVisibility.event;
    }

    constructor() {
        Container.explorerCommands;
        commands.registerCommand('gitlens.gitExplorer.refresh', this.refresh, this);
        commands.registerCommand('gitlens.gitExplorer.refreshNode', this.refreshNode, this);
        commands.registerCommand(
            'gitlens.gitExplorer.setFilesLayoutToAuto',
            () => this.setFilesLayout(ExplorerFilesLayout.Auto),
            this
        );
        commands.registerCommand(
            'gitlens.gitExplorer.setFilesLayoutToList',
            () => this.setFilesLayout(ExplorerFilesLayout.List),
            this
        );
        commands.registerCommand(
            'gitlens.gitExplorer.setFilesLayoutToTree',
            () => this.setFilesLayout(ExplorerFilesLayout.Tree),
            this
        );

        commands.registerCommand(
            'gitlens.gitExplorer.setAutoRefreshToOn',
            () => this.setAutoRefresh(Container.config.gitExplorer.autoRefresh, true),
            this
        );
        commands.registerCommand(
            'gitlens.gitExplorer.setAutoRefreshToOff',
            () => this.setAutoRefresh(Container.config.gitExplorer.autoRefresh, false),
            this
        );

        Container.context.subscriptions.push(configuration.onDidChange(this.onConfigurationChanged, this));
        this.onConfigurationChanged(configuration.initializingChangeEvent);
    }

    dispose() {
        this._disposable && this._disposable.dispose();
    }

    private async onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        if (
            !initializing &&
            !configuration.changed(e, configuration.name('gitExplorer').value) &&
            !configuration.changed(e, configuration.name('explorers').value) &&
            !configuration.changed(e, configuration.name('defaultGravatarsStyle').value)
        ) {
            return;
        }

        if (
            initializing ||
            configuration.changed(e, configuration.name('gitExplorer')('enabled').value) ||
            configuration.changed(e, configuration.name('gitExplorer')('location').value)
        ) {
            setCommandContext(CommandContext.GitExplorer, this.config.enabled ? this.config.location : false);
        }

        if (initializing || configuration.changed(e, configuration.name('gitExplorer')('autoRefresh').value)) {
            this.setAutoRefresh(Container.config.gitExplorer.autoRefresh);
        }

        if (initializing || configuration.changed(e, configuration.name('gitExplorer')('location').value)) {
            if (this._disposable) {
                this._disposable.dispose();
                this._onDidChangeTreeData = new EventEmitter<ExplorerNode>();
            }

            this.setRoot();
            this._tree = window.createTreeView(`gitlens.gitExplorer:${this.config.location}`, {
                treeDataProvider: this
            });
            this._disposable = Disposable.from(
                this._tree,
                this._tree.onDidChangeVisibility(this.onVisibilityChanged, this)
            );
        }

        if (!initializing && this._root !== undefined) {
            this.refresh(RefreshReason.ConfigurationChanged);
        }
    }

    private onRepositoriesChanged() {
        Logger.log(`GitExplorer.onRepositoriesChanged`);

        this.refresh(RefreshReason.RepoChanged);
    }

    private onVisibilityChanged(e: TreeViewVisibilityChangeEvent) {
        this._onDidChangeVisibility.fire(e);
    }

    get autoRefresh() {
        return (
            this.config.autoRefresh &&
            Container.context.workspaceState.get<boolean>(WorkspaceState.GitExplorerAutoRefresh, true)
        );
    }

    get config(): IExplorersConfig & IGitExplorerConfig {
        return { ...Container.config.explorers, ...Container.config.gitExplorer };
    }

    get visible(): boolean {
        return this._tree !== undefined ? this._tree.visible : false;
    }

    getParent(): ExplorerNode | undefined {
        return undefined;
    }

    async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
        if (this._root === undefined) {
            return [new MessageNode('No repositories found')];
        }

        if (node === undefined) {
            const root = await this._root;
            return root !== undefined ? root.getChildren() : [new MessageNode('No repositories found')];
        }
        return node.getChildren();
    }

    async getTreeItem(node: ExplorerNode): Promise<TreeItem> {
        return node.getTreeItem();
    }

    getQualifiedCommand(command: string) {
        return `gitlens.gitExplorer.${command}`;
    }

    async refresh(reason?: RefreshReason) {
        if (reason === undefined) {
            reason = RefreshReason.Command;
        }

        Logger.log(`GitExplorer.refresh`, `reason='${reason}'`);

        if (this._root !== undefined) {
            await this._root.refresh();
        }

        this._onDidChangeTreeData.fire();
    }

    refreshNode(node: ExplorerNode, args?: RefreshNodeCommandArgs) {
        Logger.log(`GitExplorer.refreshNode(${(node as { id?: string }).id || ''})`);

        if (args !== undefined && node.supportsPaging) {
            if (args.maxCount === undefined || args.maxCount === 0) {
                node.maxCount = args.maxCount;
            }
            else {
                node.maxCount = (node.maxCount || args.maxCount) + args.maxCount;
            }
        }

        node.refresh();

        // Since the root node won't actually refresh, force everything
        this._onDidChangeTreeData.fire(node === this._root ? undefined : node);
    }

    private _autoRefreshDisposable: Disposable | undefined;

    async setAutoRefresh(enabled: boolean, workspaceEnabled?: boolean) {
        if (this._autoRefreshDisposable !== undefined) {
            this._autoRefreshDisposable.dispose();
            this._autoRefreshDisposable = undefined;
        }

        let toggled = false;
        if (enabled) {
            if (workspaceEnabled === undefined) {
                workspaceEnabled = Container.context.workspaceState.get<boolean>(
                    WorkspaceState.GitExplorerAutoRefresh,
                    true
                );
            }
            else {
                toggled = workspaceEnabled;
                await Container.context.workspaceState.update(WorkspaceState.GitExplorerAutoRefresh, workspaceEnabled);

                this._onDidChangeAutoRefresh.fire();
            }

            if (workspaceEnabled) {
                this._autoRefreshDisposable = Container.git.onDidChangeRepositories(this.onRepositoriesChanged, this);
                Container.context.subscriptions.push(this._autoRefreshDisposable);
            }
        }

        setCommandContext(CommandContext.GitExplorerAutoRefresh, enabled && workspaceEnabled);

        if (toggled) {
            this.refresh(RefreshReason.AutoRefreshChanged);
        }
    }

    async show() {
        if (this._tree === undefined || this._root === undefined) return;

        const [child] = await this._root.getChildren();

        try {
            await this._tree.reveal(child, { select: false });
        }
        catch (ex) {
            Logger.error(ex);
        }
    }

    async reveal(node: ExplorerNode) {
        if (this._tree === undefined || this._root === undefined) return;

        try {
            await this._tree.reveal(node, { select: false });
        }
        catch (ex) {
            Logger.error(ex);
        }
    }

    private setFilesLayout(layout: ExplorerFilesLayout) {
        return configuration.updateEffective(configuration.name('gitExplorer')('files')('layout').value, layout);
    }

    private setRoot() {
        if (this._root === undefined) {
            this._root = new RepositoriesNode(this);
        }
    }
}
