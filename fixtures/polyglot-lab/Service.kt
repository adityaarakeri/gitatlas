import acme.core.Base
class Service : Base() {
  fun run(): Int = 1
  private fun audit() {}
}
fun helper() = 2
private fun hidden() = 3
