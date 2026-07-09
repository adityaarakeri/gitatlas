package com.acme.auth;

import com.acme.auth.TokenStore;

public class AuthService {
    private TokenStore store = new TokenStore();

    public boolean login(String user) {
        return store.issue(user) != null;
    }

    private void audit(String event) {
    }
}
