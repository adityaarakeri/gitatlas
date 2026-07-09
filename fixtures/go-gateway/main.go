package main

import "example.com/gateway/router"

func main() {
	r := router.NewRouter()
	r.Handle("/health")
}
