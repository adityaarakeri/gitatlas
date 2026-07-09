require_relative 'tax'

class Invoice
  def total(amount)
    amount + tax_for(amount)
  end
end

class LateInvoice < Invoice
  def total(amount)
    super(amount) * 1.1
  end
end
