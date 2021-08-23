/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {ViewModel} from "../ViewModel.js";
import {PasswordLoginViewModel} from "./PasswordLoginViewModel.js";
import {StartSSOLoginViewModel} from "./StartSSOLoginViewModel.js";
import {CompleteSSOLoginViewModel} from "./CompleteSSOLoginViewModel.js";
import {LoadStatus} from "../../matrix/SessionContainer.js";
import {SessionLoadViewModel} from "../SessionLoadViewModel.js";

export class LoginViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {ready, defaultHomeServer, createSessionContainer, loginToken} = options;
        this._createSessionContainer = createSessionContainer;
        this._ready = ready;
        this._loginToken = loginToken;
        this._sessionContainer = this._createSessionContainer();
        this._loginOptions = null;
        this._passwordLoginViewModel = null;
        this._startSSOLoginViewModel = null;
        this._completeSSOLoginViewModel = null;
        this._loadViewModel = null;
        this._loadViewModelSubscription = null;
        this._homeserver = defaultHomeServer;
        this._errorMessage = "";
        this._hideHomeserver = false;
        this._isBusy = false;
        this._abortHomeserverQueryTimeout = null;
        this._abortQueryOperation = null;
        this._initViewModels();
    }

    get passwordLoginViewModel() { return this._passwordLoginViewModel; }
    get startSSOLoginViewModel() { return this._startSSOLoginViewModel; }
    get completeSSOLoginViewModel(){ return this._completeSSOLoginViewModel; }
    get homeserver() { return this._homeserver; }
    get errorMessage() { return this._errorMessage; }
    get showHomeserver() { return !this._hideHomeserver; }
    get loadViewModel() {return this._loadViewModel; }
    get isBusy() { return this._isBusy; }
    get isFetchingLoginOptions() { return !!this._abortQueryOperation; }

    goBack() {
        this.navigation.push("session");
    }

    async _initViewModels() {
        if (this._loginToken) {
            this._hideHomeserver = true;
            this._completeSSOLoginViewModel = this.track(new CompleteSSOLoginViewModel(
                this.childOptions(
                    {
                        sessionContainer: this._sessionContainer,
                        attemptLogin: loginMethod => this.attemptLogin(loginMethod),
                        loginToken: this._loginToken
                    })));
            this.emitChange("completeSSOLoginViewModel");
        }
        else {
            await this.queryHomeServer();
        }
    }

    _showPasswordLogin() {
        this._passwordLoginViewModel = this.track(new PasswordLoginViewModel(
            this.childOptions({
                loginOptions: this._loginOptions,
                attemptLogin: loginMethod => this.attemptLogin(loginMethod)
        })));
        this.emitChange("passwordLoginViewModel");
    }

    _showSSOLogin() {
        this._startSSOLoginViewModel = this.track(
            new StartSSOLoginViewModel(this.childOptions({loginOptions: this._loginOptions}))
        );
        this.emitChange("startSSOLoginViewModel");
    }

    _showError(message) {
        this._errorMessage = message;
        this.emitChange("errorMessage");
    }

    _setBusy(status) {
        this._isBusy = status;
        this._passwordLoginViewModel?.setBusy(status);
        this._startSSOLoginViewModel?.setBusy(status);
        this.emitChange("isBusy");
    }

    async attemptLogin(loginMethod) {
        this._setBusy(true);
        this._sessionContainer.startWithLogin(loginMethod);
        const loadStatus = this._sessionContainer.loadStatus;
        const handle = loadStatus.waitFor(status => status !== LoadStatus.Login);
        await handle.promise;
        this._setBusy(false);
        const status = loadStatus.get();
        if (status === LoadStatus.LoginFailed) {
            return this._sessionContainer.loginFailure;
        }
        this._hideHomeserver = true;
        this.emitChange("hideHomeserver");
        this._disposeViewModels();
        this._createLoadViewModel();
        return null;
    }

    _createLoadViewModel() {
        this._loadViewModelSubscription = this.disposeTracked(this._loadViewModelSubscription);
        this._loadViewModel = this.disposeTracked(this._loadViewModel);
        this._loadViewModel = this.track(
            new SessionLoadViewModel(
                this.childOptions({
                    ready: (sessionContainer) => {
                        // make sure we don't delete the session in dispose when navigating away
                        this._sessionContainer = null;
                        this._ready(sessionContainer);
                    },
                    sessionContainer: this._sessionContainer,
                    homeserver: this._homeserver
                })
            )
        );
        this._loadViewModel.start();
        this.emitChange("loadViewModel");
        this._loadViewModelSubscription = this.track(
            this._loadViewModel.disposableOn("change", () => {
                if (!this._loadViewModel.loading) {
                    this._loadViewModelSubscription = this.disposeTracked(this._loadViewModelSubscription);
                }
                this._setBusy(false);
            })
        );
    }

    _disposeViewModels() {
        this._startSSOLoginViewModel = this.disposeTracked(this._ssoLoginViewModel);
        this._passwordLoginViewModel = this.disposeTracked(this._passwordLoginViewModel);
        this._completeSSOLoginViewModel = this.disposeTracked(this._completeSSOLoginViewModel);
        this.emitChange("disposeViewModels");
    }

    async setHomeServer(newHomeserver) {
        this._homeserver = newHomeserver;
        // abort ongoing query, if any
        this._abortQueryOperation = this.disposeTracked(this._abortQueryOperation);
        this.emitChange("isFetchingLoginOptions");
        this.disposeTracked(this._abortHomeserverQueryTimeout);
        const timeout = this.clock.createTimeout(2000);
        this._abortHomeserverQueryTimeout = this.track(() => timeout.abort());
        try {
            await timeout.elapsed();
        } catch (err) {
            if (err.name === "AbortError") {
                return; // still typing, don't query
            } else {
                throw err;
            }
        }
        this._abortHomeserverQueryTimeout = this.disposeTracked(this._abortHomeserverQueryTimeout);
        this.queryHomeServer();
    }
    
    async queryHomeServer() {
        this._errorMessage = "";
        this.emitChange("errorMessage");
        // if query is called before the typing timeout hits (e.g. field lost focus), cancel the timeout so we don't query again.
        this._abortHomeserverQueryTimeout = this.disposeTracked(this._abortHomeserverQueryTimeout);
        // cancel ongoing query operation, if any
        this._abortQueryOperation = this.disposeTracked(this._abortQueryOperation);
        this._disposeViewModels();
        try {
            const queryOperation = this._sessionContainer.queryLogin(this._homeserver);
            this._abortQueryOperation = this.track(() => queryOperation.abort());
            this.emitChange("isFetchingLoginOptions");
            this._loginOptions = await queryOperation.result;
        }
        catch (e) {
            console.log("error", e);
            if (e.name === "AbortError") {
                return; //aborted, bail out
            } else {
                this._loginOptions = null;
            }
        } finally {
            this._abortQueryOperation = this.disposeTracked(this._abortQueryOperation);
            this.emitChange("isFetchingLoginOptions");
        }
        if (this._loginOptions) {
            if (this._loginOptions.sso) { this._showSSOLogin(); }
            if (this._loginOptions.password) { this._showPasswordLogin(); }
            if (!this._loginOptions.sso && !this._loginOptions.password) {
                this._showError("This homeserver supports neither SSO nor password based login flows");
            } 
        }
        else {
            this._showError("Could not query login methods supported by the homeserver");
        }
    }

    dispose() {
        super.dispose();
        if (this._sessionContainer) {
            // if we move away before we're done with initial sync
            // delete the session
            this._sessionContainer.deleteSession();
        }
    }
}