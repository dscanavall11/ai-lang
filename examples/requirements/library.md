# Community Library

A small public library wants to replace its paper ledger. Members borrow books,
return them, and pay a fine when they are late. Staff add new books and retire
worn ones.

## Glossary

- Member: someone entitled to borrow from the library.
- Loan: the record of one copy being out with one member.
- Copy: a single physical book on the shelf.
- Fine: money a member owes for returning a loan after its due date.

## Members

- As a member, I want to join the library so that I can borrow books.
- As a member, I want to see my current loans so that I know what I still hold.

A member has a name, an email address and a membership number.
A member cannot borrow while they owe an unpaid fine.

## Books

- As a librarian, I want to add a book so that members can borrow it.
- As a librarian, I want to retire a copy so that damaged books leave circulation.

A book has a title, an author and an ISBN.
A book has one or more copies.
A copy has a shelf location and a condition.

## Borrowing

- As a member, I want to borrow a copy so that I can read it at home.
- As a member, I want to return a copy so that someone else can borrow it.

A loan has a due date fourteen days after it starts.
A loan must reference exactly one copy and one member.
A member cannot hold more than five loans at once.
When a loan is returned after its due date, the library charges a fine.

## Fines

- As a member, I want to pay a fine so that I can borrow again.

A fine has an amount in euros and a state.
A fine is one euro for every day a loan is late.
A fine cannot be negative.
