import * as vscode from 'vscode';
import { UserAccount } from '../types';

export class AuthService {
  private static readonly SECRET_KEY = 'failurelens.authToken';
  private static readonly USER_KEY = 'failurelens.userData';
  private currentUser: UserAccount | null = null;
  private onAuthStateChangedEmitter = new vscode.EventEmitter<UserAccount | null>();
  public readonly onAuthStateChanged = this.onAuthStateChangedEmitter.event;

  constructor(private context: vscode.ExtensionContext) {
    this.restoreSession();
  }

  private async restoreSession() {
    const token = await this.context.secrets.get(AuthService.SECRET_KEY);
    const userData = this.context.globalState.get<UserAccount>(AuthService.USER_KEY);
    if (token && userData) {
      this.currentUser = { ...userData, token };
      this.onAuthStateChangedEmitter.fire(this.currentUser);
    }
  }

  public isAuthenticated(): boolean {
    return this.currentUser !== null;
  }

  public getCurrentUser(): UserAccount | null {
    return this.currentUser;
  }

  public async signIn(): Promise<UserAccount | null> {
    const config = vscode.workspace.getConfiguration('failurelens');
    const dashboardUrl = config.get<string>('dashboardUrl', 'https://app.failurelens.io');

    const choice = await vscode.window.showInformationMessage(
      'Sign in to FailureLens via browser or enter an API token.',
      'Open Browser',
      'Enter Token'
    );

    if (!choice) {
      return null;
    }

    if (choice === 'Open Browser') {
      vscode.env.openExternal(vscode.Uri.parse(`${dashboardUrl}/auth/cli`));
    }

    // Prompt for token
    const tokenInput = await vscode.window.showInputBox({
      title: 'FailureLens API Token',
      prompt: 'Paste your personal API token from FailureLens settings',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'fl_live_...'
    });

    if (!tokenInput || tokenInput.trim().length === 0) {
      vscode.window.showWarningMessage('Sign in cancelled: No token provided.');
      return null;
    }

    const token = tokenInput.trim();
    // Simulate/Set authenticated user profile
    const user: UserAccount = {
      email: 'engineer@organization.com',
      name: 'Software Engineer',
      organization: 'Acme Payments Team',
      token
    };

    await this.context.secrets.store(AuthService.SECRET_KEY, token);
    await this.context.globalState.update(AuthService.USER_KEY, {
      email: user.email,
      name: user.name,
      organization: user.organization
    });

    this.currentUser = user;
    this.onAuthStateChangedEmitter.fire(this.currentUser);
    vscode.window.showInformationMessage(`Signed in to FailureLens as ${user.email} (${user.organization}).`);
    return this.currentUser;
  }

  public async signOut(): Promise<void> {
    await this.context.secrets.delete(AuthService.SECRET_KEY);
    await this.context.globalState.update(AuthService.USER_KEY, undefined);
    this.currentUser = null;
    this.onAuthStateChangedEmitter.fire(null);
    vscode.window.showInformationMessage('Signed out of FailureLens.');
  }

  public async switchAccount(): Promise<void> {
    await this.signOut();
    await this.signIn();
  }
}
