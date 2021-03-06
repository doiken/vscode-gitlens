'use strict';
import {
    CancellationToken,
    ConfigurationChangeEvent,
    debug,
    Disposable,
    Hover,
    HoverProvider,
    languages,
    Position,
    Range,
    TextDocument,
    TextEditor,
    window
} from 'vscode';
import { Annotations } from '../annotations/annotations';
import { configuration } from '../configuration';
import { Container } from '../container';
import { LinesChangeEvent } from '../trackers/gitLineTracker';

export class LineHoverController extends Disposable {
    private _debugSessionEndDisposable: Disposable | undefined;
    private _disposable: Disposable;
    private _hoverProviderDisposable: Disposable | undefined;

    constructor() {
        super(() => this.dispose());

        this._disposable = Disposable.from(
            configuration.onDidChange(this.onConfigurationChanged, this),
            debug.onDidStartDebugSession(this.onDebugSessionStarted, this)
        );
        this.onConfigurationChanged(configuration.initializingChangeEvent);
    }

    dispose() {
        this.unregister();

        this._debugSessionEndDisposable && this._debugSessionEndDisposable.dispose();

        Container.lineTracker.stop(this);
        this._disposable && this._disposable.dispose();
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        if (
            !initializing &&
            !configuration.changed(e, configuration.name('hovers')('enabled').value) &&
            !configuration.changed(e, configuration.name('hovers')('currentLine')('enabled').value)
        ) {
            return;
        }

        if (Container.config.hovers.enabled && Container.config.hovers.currentLine.enabled) {
            Container.lineTracker.start(
                this,
                Disposable.from(Container.lineTracker.onDidChangeActiveLines(this.onActiveLinesChanged, this))
            );

            this.register(window.activeTextEditor);
        }
        else {
            Container.lineTracker.stop(this);
            this.unregister();
        }
    }

    private get debugging() {
        return this._debugSessionEndDisposable !== undefined;
    }

    private onActiveLinesChanged(e: LinesChangeEvent) {
        if (e.pending || e.reason !== 'editor') return;

        if (e.editor === undefined || e.lines === undefined) {
            this.unregister();

            return;
        }

        this.register(e.editor);
    }

    private onDebugSessionStarted() {
        if (this._debugSessionEndDisposable === undefined) {
            this._debugSessionEndDisposable = debug.onDidTerminateDebugSession(this.onDebugSessionEnded, this);
        }
    }

    private onDebugSessionEnded() {
        if (this._debugSessionEndDisposable !== undefined) {
            this._debugSessionEndDisposable.dispose();
            this._debugSessionEndDisposable = undefined;
        }
    }

    async provideDetailsHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken
    ): Promise<Hover | undefined> {
        if (!Container.lineTracker.includes(position.line)) return undefined;

        const lineState = Container.lineTracker.getState(position.line);
        const commit = lineState !== undefined ? lineState.commit : undefined;
        if (commit === undefined) return undefined;

        // Avoid double annotations if we are showing the whole-file hover blame annotations
        const fileAnnotations = await Container.fileAnnotations.getAnnotationType(window.activeTextEditor);
        if (fileAnnotations !== undefined && Container.config.hovers.annotations.details) return undefined;

        const wholeLine = this.debugging ? false : Container.config.hovers.currentLine.over === 'line';
        // If we aren't showing the hover over the whole line, make sure the annotation is on
        if (!wholeLine && Container.lineAnnotations.suspended) return undefined;

        const range = document.validateRange(
            new Range(position.line, wholeLine ? 0 : Number.MAX_SAFE_INTEGER, position.line, Number.MAX_SAFE_INTEGER)
        );
        if (!wholeLine && range.start.character !== position.character) return undefined;

        // Get the full commit message -- since blame only returns the summary
        let logCommit = lineState !== undefined ? lineState.logCommit : undefined;
        if (logCommit === undefined && !commit.isUncommitted) {
            logCommit = await Container.git.getLogCommitForFile(commit.repoPath, commit.uri.fsPath, {
                ref: commit.sha
            });
            if (logCommit !== undefined) {
                // Preserve the previous commit from the blame commit
                logCommit.previousSha = commit.previousSha;
                logCommit.previousFileName = commit.previousFileName;

                if (lineState !== undefined) {
                    lineState.logCommit = logCommit;
                }
            }
        }

        const trackedDocument = await Container.tracker.get(document);
        if (trackedDocument === undefined) return undefined;

        const message = Annotations.getHoverMessage(
            logCommit || commit,
            Container.config.defaultDateFormat,
            await Container.git.getRemotes(commit.repoPath),
            fileAnnotations,
            position.line
        );
        return new Hover(message, range);
    }

    async provideChangesHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken
    ): Promise<Hover | undefined> {
        if (!Container.lineTracker.includes(position.line)) return undefined;

        const lineState = Container.lineTracker.getState(position.line);
        const commit = lineState !== undefined ? lineState.commit : undefined;
        if (commit === undefined) return undefined;

        // Avoid double annotations if we are showing the whole-file hover blame annotations
        if (Container.config.hovers.annotations.changes) {
            const fileAnnotations = await Container.fileAnnotations.getAnnotationType(window.activeTextEditor);
            if (fileAnnotations !== undefined) return undefined;
        }

        const wholeLine = this.debugging ? false : Container.config.hovers.currentLine.over === 'line';
        // If we aren't showing the hover over the whole line, make sure the annotation is on
        if (!wholeLine && Container.lineAnnotations.suspended) return undefined;

        const range = document.validateRange(
            new Range(position.line, wholeLine ? 0 : Number.MAX_SAFE_INTEGER, position.line, Number.MAX_SAFE_INTEGER)
        );
        if (!wholeLine && range.start.character !== position.character) return undefined;

        const trackedDocument = await Container.tracker.get(document);
        if (trackedDocument === undefined) return undefined;

        const hover = await Annotations.changesHover(commit, position.line, trackedDocument.uri);
        if (hover.hoverMessage === undefined) return undefined;

        return new Hover(hover.hoverMessage, range);
    }

    private register(editor: TextEditor | undefined) {
        this.unregister();

        if (editor === undefined /* || this.suspended */) return;

        const cfg = Container.config.hovers;
        if (!cfg.enabled || !cfg.currentLine.enabled || (!cfg.currentLine.details && !cfg.currentLine.changes)) return;

        const subscriptions = [];
        if (cfg.currentLine.changes) {
            subscriptions.push(
                languages.registerHoverProvider({ pattern: editor.document.uri.fsPath }, {
                    provideHover: this.provideChangesHover.bind(this)
                } as HoverProvider)
            );
        }
        if (cfg.currentLine.details) {
            subscriptions.push(
                languages.registerHoverProvider({ pattern: editor.document.uri.fsPath }, {
                    provideHover: this.provideDetailsHover.bind(this)
                } as HoverProvider)
            );
        }

        this._hoverProviderDisposable = Disposable.from(...subscriptions);
    }

    private unregister() {
        if (this._hoverProviderDisposable !== undefined) {
            this._hoverProviderDisposable.dispose();
            this._hoverProviderDisposable = undefined;
        }
    }
}
