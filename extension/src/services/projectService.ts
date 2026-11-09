import * as vscode from 'vscode';
import { ProjectInfo } from '../types';

export class ProjectService {
  private static readonly ACTIVE_PROJECT_KEY = 'failurelens.activeProjectData';
  private currentProject: ProjectInfo | null = null;
  private onProjectChangedEmitter = new vscode.EventEmitter<ProjectInfo | null>();
  public readonly onProjectChanged = this.onProjectChangedEmitter.event;

  constructor(private context: vscode.ExtensionContext) {
    this.restoreProject();
  }

  private restoreProject() {
    const saved = this.context.workspaceState.get<ProjectInfo>(ProjectService.ACTIVE_PROJECT_KEY);
    if (saved) {
      this.currentProject = saved;
    } else {
      // Auto-detect default workspace repo
      const repoName = this.detectRepoName();
      if (repoName) {
        this.currentProject = {
          id: `proj_${repoName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          name: repoName,
          repo: repoName,
          createdAt: new Date().toISOString()
        };
        this.context.workspaceState.update(ProjectService.ACTIVE_PROJECT_KEY, this.currentProject);
      }
    }
  }

  public detectRepoName(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].name;
    }
    return 'FailureLens';
  }

  public getActiveProject(): ProjectInfo | null {
    return this.currentProject;
  }

  public async selectProject(): Promise<ProjectInfo | null> {
    const defaultName = this.detectRepoName();

    const options = [
      { label: `$(repo) ${defaultName} (Current Repository)`, description: 'Active workspace repository', id: `proj_${defaultName}` },
      { label: '$(plus) Link another repository...', description: 'Link open workspace to a custom project ID', id: 'CREATE_NEW' }
    ];

    const pick = await vscode.window.showQuickPick(options, {
      title: 'FailureLens: Active Repository Project',
      placeHolder: 'Select a project to associate with this workspace'
    });

    if (!pick) {
      return null;
    }

    if (pick.id === 'CREATE_NEW') {
      const name = await vscode.window.showInputBox({
        title: 'Create Basic FailureLens Project',
        prompt: 'Enter a project name (finish full settings on web dashboard)',
        value: defaultName
      });
      if (!name) {
        return null;
      }
      this.currentProject = {
        id: `proj_${Date.now()}`,
        name: name.trim(),
        repo: defaultName,
        createdAt: new Date().toISOString()
      };
    } else {
      this.currentProject = {
        id: pick.id,
        name: pick.label.replace(/\$\([^)]+\)\s*/, ''),
        repo: defaultName,
        createdAt: new Date().toISOString()
      };
    }

    await this.context.workspaceState.update(ProjectService.ACTIVE_PROJECT_KEY, this.currentProject);
    const config = vscode.workspace.getConfiguration('failurelens');
    await config.update('activeProject', this.currentProject.id, vscode.ConfigurationTarget.Workspace);

    this.onProjectChangedEmitter.fire(this.currentProject);
    vscode.window.showInformationMessage(`Active FailureLens project set to: ${this.currentProject.name}`);
    return this.currentProject;
  }
}
