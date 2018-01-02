'use strict';
import { Objects, Versions } from './system';
import { ConfigurationTarget, ExtensionContext, extensions, languages, window, workspace } from 'vscode';
import { AnnotationController } from './annotations/annotationController';
import { configuration, Configuration, IConfig } from './configuration';
import { CommandContext, ExtensionKey, GlobalState, QualifiedExtensionId, setCommandContext } from './constants';
import { CodeLensController } from './codeLensController';
import { configureCommands } from './commands';
import { CurrentLineController } from './currentLineController';
import { ExplorerCommands } from './views/explorerCommands';
import { GitContentProvider } from './gitContentProvider';
import { GitExplorer } from './views/gitExplorer';
import { GitRevisionCodeLensProvider } from './gitRevisionCodeLensProvider';
import { GitContextTracker, GitService } from './gitService';
import { Keyboard } from './keyboard';
import { Logger } from './logger';
import { Messages, SuppressedMessages } from './messages';
import { ResultsExplorer } from './views/resultsExplorer';
// import { Telemetry } from './telemetry';

// this method is called when your extension is activated
export async function activate(context: ExtensionContext) {
    const start = process.hrtime();

    Logger.configure(context);
    Configuration.configure(context);

    const gitlens = extensions.getExtension(QualifiedExtensionId)!;
    const gitlensVersion = gitlens.packageJSON.version;

    const cfg = configuration.get<IConfig>();

    try {
        await GitService.initialize(cfg.advanced.git);
    }
    catch (ex) {
        Logger.error(ex, `GitLens(v${gitlensVersion}).activate`);
        if (ex.message.includes('Unable to find git')) {
            await window.showErrorMessage(`GitLens was unable to find Git. Please make sure Git is installed. Also ensure that Git is either in the PATH, or that '${ExtensionKey}.${configuration.name('advanced')('git').value}' is pointed to its installed location.`);
        }
        setCommandContext(CommandContext.Enabled, false);
        return;
    }

    const gitVersion = GitService.getGitVersion();

    // Telemetry.configure(ApplicationInsightsKey);

    // const telemetryContext: { [id: string]: any } = Object.create(null);
    // telemetryContext.version = gitlensVersion;
    // telemetryContext['git.version'] = gitVersion;
    // Telemetry.setContext(telemetryContext);

    const previousVersion = context.globalState.get<string>(GlobalState.GitLensVersion);

    await migrateSettings(context, previousVersion);
    notifyOnUnsupportedGitVersion(context, gitVersion);
    notifyOnNewGitLensVersion(context, gitlensVersion, previousVersion);

    context.globalState.update(GlobalState.GitLensVersion, gitlensVersion);

    const git = new GitService();
    context.subscriptions.push(git);

    const gitContextTracker = new GitContextTracker(git);
    context.subscriptions.push(gitContextTracker);

    const annotationController = new AnnotationController(context, git, gitContextTracker);
    context.subscriptions.push(annotationController);

    const currentLineController = new CurrentLineController(context, git, gitContextTracker, annotationController);
    context.subscriptions.push(currentLineController);

    const codeLensController = new CodeLensController(context, git, gitContextTracker);
    context.subscriptions.push(codeLensController);

    context.subscriptions.push(workspace.registerTextDocumentContentProvider(GitContentProvider.scheme, new GitContentProvider(context, git)));
    context.subscriptions.push(languages.registerCodeLensProvider(GitRevisionCodeLensProvider.selector, new GitRevisionCodeLensProvider(context, git)));

    const explorerCommands = new ExplorerCommands(context, git);
    context.subscriptions.push(explorerCommands);

    context.subscriptions.push(window.registerTreeDataProvider('gitlens.gitExplorer', new GitExplorer(context, explorerCommands, git, gitContextTracker)));
    context.subscriptions.push(window.registerTreeDataProvider('gitlens.resultsExplorer', new ResultsExplorer(context, explorerCommands, git)));

    context.subscriptions.push(new Keyboard());

    configureCommands(context, git, annotationController, currentLineController, codeLensController);

    // Constantly over my data cap so stop collecting initialized event
    // Telemetry.trackEvent('initialized', Objects.flatten(cfg, 'config', true));

    // Slightly delay enabling the explorer to not stop the rest of GitLens from being usable
    setTimeout(() => setCommandContext(CommandContext.GitExplorer, true), 1000);

    const duration = process.hrtime(start);
    Logger.log(`GitLens(v${gitlensVersion}) activated in ${(duration[0] * 1000) + Math.floor(duration[1] / 1000000)} ms`);
}

// this method is called when your extension is deactivated
export function deactivate() { }

async function migrateSettings(context: ExtensionContext, previousVersion: string | undefined) {
    if (previousVersion === undefined) return;

    const previous = Versions.fromString(previousVersion);

    try {
        if (Versions.compare(previous, Versions.from(6, 1, 2)) !== 1) {
            try {
                const section = configuration.name('advanced')('messages').value;
                const messages: { [key: string]: boolean } = configuration.get(section);

                let migrated = false;

                for (const m of Objects.values(SuppressedMessages)) {
                    const suppressed = context.globalState.get<boolean>(m);
                    if (suppressed === undefined) continue;

                    migrated = true;
                    messages[m] = suppressed;

                    context.globalState.update(m, undefined);
                }

                if (!migrated) return;

                await configuration.update(section, messages, ConfigurationTarget.Global);
            }
            catch (ex) {
                Logger.error(ex, 'migrateSettings - messages');
            }
        }

        if (Versions.compare(previous, Versions.from(7, 1, 0)) !== 1) {
            // https://github.com/eamodio/vscode-gitlens/issues/239
            const section = configuration.name('advanced')('quickPick')('closeOnFocusOut').value;
            const inspection = configuration.inspect(section);
            if (inspection !== undefined) {
                if (inspection.globalValue !== undefined) {
                    await configuration.update(section, !inspection.globalValue, ConfigurationTarget.Global);
                }
                else if (inspection.workspaceFolderValue !== undefined) {
                    await configuration.update(section, !inspection.workspaceFolderValue, ConfigurationTarget.WorkspaceFolder);
                }
            }
        }
    }
    catch (ex) {
        Logger.error(ex, 'migrateSettings');
    }
}

async function notifyOnNewGitLensVersion(context: ExtensionContext, version: string, previousVersion: string | undefined) {
    if (configuration.get<boolean>(configuration.name('advanced')('messages')(SuppressedMessages.UpdateNotice).value)) return;

    if (previousVersion === undefined) {
        Logger.log(`GitLens first-time install`);
        await Messages.showWelcomeMessage();

        return;
    }

    if (previousVersion !== version) {
        Logger.log(`GitLens upgraded from v${previousVersion} to v${version}`);
    }

    const [major, minor] = version.split('.');
    const [prevMajor, prevMinor] = previousVersion.split('.');
    if (major === prevMajor && minor === prevMinor) return;
    // Don't notify on downgrades
    if (major < prevMajor || (major === prevMajor && minor < prevMinor)) return;

    await Messages.showUpdateMessage(version);
}

async function notifyOnUnsupportedGitVersion(context: ExtensionContext, version: string) {
    if (GitService.validateGitVersion(2, 2)) return;

    // If git is less than v2.2.0
    await Messages.showUnsupportedGitVersionErrorMessage(version);
}