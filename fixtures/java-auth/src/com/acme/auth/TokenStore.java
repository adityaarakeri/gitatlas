package com.acme.auth;

public class TokenStore {
    public String issue(String user) {
        return user + ":token";
    }
}
