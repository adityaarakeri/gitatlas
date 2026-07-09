use crate::norm;
pub struct Point { x: i32 }
pub trait Shape { }
impl Point {
  pub fn norm(&self) -> i32 { self.x }
  fn secret(&self) -> i32 { 0 }
}
pub fn area(w: i32) -> i32 { w }
fn hidden() {}
