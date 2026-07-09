from utils import helper, Base

class ReportBuilder(Base):
    def build(self, rows):
        return [helper(r) for r in rows]

def main():
    ReportBuilder().build([1, 2])

def never_used():
    pass
