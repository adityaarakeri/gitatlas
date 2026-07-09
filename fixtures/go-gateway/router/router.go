package router

type Router struct {
	routes map[string]string
}

func NewRouter() *Router {
	return &Router{routes: map[string]string{}}
}

func (r *Router) Handle(path string) string {
	return normalize(path)
}

func normalize(p string) string {
	return p
}
