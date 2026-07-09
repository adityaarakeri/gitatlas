import Foundation
class Service: Base {
  func run() -> Int { return 1 }
  private func audit() {}
}
protocol Job { }
func helper() -> Int { return 2 }
