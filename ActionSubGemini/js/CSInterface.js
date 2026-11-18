/**
 * CSInterface - v11.0.0
 * Adobe CEP JavaScript Interface standard implementation
 */
(function(window) {
    'use strict';

    function CSInterface() {}

    CSInterface.prototype.THEME_COLOR_CHANGED_EVENT = "com.adobe.csxs.events.ThemeColorChanged";

    CSInterface.prototype.getHostEnvironment = function() {
        var defaultResponse = '{"appId":"PPRO","appVersion":"14.0","appLocale":"en_US","appName":"Premiere Pro"}';
        if (window.__adobe_cep__) {
            var hostEnvStr = window.__adobe_cep__.getHostEnvironment();
            return JSON.parse(hostEnvStr);
        }
        return JSON.parse(defaultResponse);
    };

    CSInterface.prototype.closeExtension = function() {
        if (window.__adobe_cep__) {
            window.__adobe_cep__.closeExtension();
        }
    };

    CSInterface.prototype.getSystemPath = function(pathType) {
        var path = "";
        var SystemPath = {
            USER_DATA: "userData",
            COMMON_FILES: "commonFiles",
            MY_DOCUMENTS: "myDocuments",
            APPLICATION: "application",
            EXTENSION: "extension",
            HOST_APPLICATION: "hostApplication"
        };

        if (window.__adobe_cep__) {
            path = window.__adobe_cep__.getSystemPath(pathType);
        }
        return path;
    };

    CSInterface.prototype.evalScript = function(script, callback) {
        if (window.__adobe_cep__) {
            if (callback === null || callback === undefined) {
                callback = function(result) {};
            }
            window.__adobe_cep__.evalScript(script, callback);
        } else {
            console.warn("[CSInterface] Outside CEP environment. evalScript ignored:", script);
            if (callback) {
                callback('{"error":"Not in Adobe CEP environment"}');
            }
        }
    };

    CSInterface.prototype.addEventListener = function(type, listener, obj) {
        if (window.__adobe_cep__) {
            window.__adobe_cep__.addEventListener(type, listener, obj);
        }
    };

    CSInterface.prototype.removeEventListener = function(type, listener, obj) {
        if (window.__adobe_cep__) {
            window.__adobe_cep__.removeEventListener(type, listener, obj);
        }
    };

    CSInterface.prototype.dispatchEvent = function(event) {
        if (window.__adobe_cep__) {
            window.__adobe_cep__.dispatchEvent(event);
        }
    };

    CSInterface.prototype.openURLInDefaultBrowser = function(url) {
        if (window.cep && window.cep.util) {
            window.cep.util.openURLInDefaultBrowser(url);
        } else if (typeof require !== 'undefined') {
            try {
                var child_process = require('child_process');
                var startCmd = process.platform === 'win32' ? 'start ""' : 'open';
                child_process.exec(startCmd + ' "' + url + '"');
            } catch (e) {
                window.open(url, '_blank');
            }
        } else {
            window.open(url, '_blank');
        }
    };

    window.CSInterface = CSInterface;
    window.SystemPath = {
        USER_DATA: "userData",
        COMMON_FILES: "commonFiles",
        MY_DOCUMENTS: "myDocuments",
        APPLICATION: "application",
        EXTENSION: "extension",
        HOST_APPLICATION: "hostApplication"
    };
})(window);
