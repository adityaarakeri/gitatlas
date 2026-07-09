<?php
require_once 'lib/tax.php';
class Invoice extends Model {
  public function total() { return 1; }
  private function log() {}
}
function helper() { return 2; }
