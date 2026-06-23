---
author: Alexey Ermolaev
pubDatetime: 2025-10-12T09:11:00Z
modDatetime: 2025-10-12T09:11:00Z
title: Elephant VM - stack-based VM written in Rust
slug: elephant-vm-rust
featured: true
draft: false
tags:
  - rust
  - vm
  - stack
  - compiler
description: An implementation of a simple stack-based VM written in Rust
headerArt: /art/elephant-vm.svg
---

I've always wanted to build a virtual machine from scratch. There's something fascinating about creating a system that can execute code, manage memory, and handle control flow - essentially building a computer within a computer.

As a result, I created [Elephant VM](https://github.com/ermolushka/elephant-vm) - a complete stack-based virtual machine written in pure Rust. This project has been a nice learning journey, taking me through lexical analysis, parsing, bytecode generation, and runtime execution.

## What is a Stack-Based VM?

A stack-based virtual machine is a type of virtual machine that uses a stack data structure to perform operations. Unlike register-based VMs that use CPU-like registers, stack VMs push operands onto a stack and pop them off to perform operations. This design is elegant because it simplifies instruction encoding and makes the VM easier to implement.

Think of it like a calculator that uses Reverse Polish Notation (RPN). Instead of writing `2 + 3`, you'd write `2 3 +` - push 2, push 3, then add them together.

## The Architecture

The Elephant VM follows a classic three-stage architecture:

```
Source Code → Scanner → Compiler → VM → Execution Result
```

### 1. Scanner (Lexical Analysis)
The scanner takes raw source code and breaks it down into tokens - the smallest meaningful units of the language. It handles:

- **Literals**: Numbers (`42`, `3.14159`), strings, booleans (`true`, `false`), `nil`
- **Keywords**: `var`, `fun`, `class`, `if`, `while`, `for`, `return`
- **Operators**: `+`, `-`, `*`, `/`, `==`, `!=`, `>`, `<`, `!`
- **Punctuation**: `(`, `)`, `{`, `}`, `;`, `.`

### 2. Compiler (Parsing & Bytecode Generation)
The compiler takes tokens and generates bytecode - a compact, platform-independent representation of the program. It uses Pratt parsing for handling operator precedence elegantly.

### 3. VM (Runtime Execution)
The VM executes the bytecode using a stack and various runtime structures to manage variables, function calls, and control flow.

## Key Features Implemented

### Expressions and Operators
The VM supports a full range of expressions with proper operator precedence:

```rust
// Arithmetic
2 + 3 * 4        // Evaluates to 14, not 20
(2 + 3) * 4      // Explicit grouping

// Comparison
5 > 3 == true    // Boolean logic
!(5 > 3)         // Logical negation
```

### Variables and Scoping
Both global and local variables are supported with proper lexical scoping:

```rust
var global = 42;

{
    var local = 10;
    print global + local;  // 52
}
// local is out of scope here
```

### Control Flow
Complete control flow constructs including if-else, while loops, and for loops:

```rust
// If-else branching
if (age >= 18) {
    print "adult";
} else {
    print "minor";
}

// While loop
var count = 5;
while (count > 0) {
    print count;
    count = count - 1;
}

// For loop
for (var i = 1; i <= 3; i = i + 1) {
    print i;
}
```

### Functions
First-class functions with proper call stack management:

```rust
fun fibonacci(n) {
    if (n <= 1) {
        return n;
    }
    return fibonacci(n - 1) + fibonacci(n - 2);
}

print fibonacci(10);  // 55
```

### Closures
Lexical scoping with closure support - functions can capture variables from their enclosing scope:

```rust
fun makeCounter() {
    var count = 0;
    fun increment() {
        count = count + 1;
        print count;
    }
    return increment;
}

var counter = makeCounter();
counter();  // Prints 1
counter();  // Prints 2
```

### Classes and Inheritance
Object-oriented programming with single inheritance:

```rust
class Animal {
    speak() {
        print "Animal sound";
    }
}

class Dog < Animal {
    speak() {
        print "Woof!";
    }
}

var dog = Dog();
dog.speak();  // Prints "Woof!"
```

## The Stack in Action

Let's trace through a simple expression to see how the stack works:

**Expression**: `2 + 3 * 4`

**Bytecode Generated**:
```
OP_CONSTANT 0    // Push 2
OP_CONSTANT 1    // Push 3  
OP_CONSTANT 2    // Push 4
OP_MULTIPLY      // Pop 4, pop 3, push 12
OP_ADD           // Pop 12, pop 2, push 14
OP_RETURN        // Return 14
```

**Stack Evolution**:
```
[] → [2] → [2, 3] → [2, 3, 4] → [2, 12] → [14]
```

The beauty of stack-based execution is its simplicity - each instruction either pushes a value onto the stack or pops values, performs an operation, and pushes the result back.

## Implementation Highlights

### Pratt Parsing for Operator Precedence
One of the most elegant parts of the implementation is how operator precedence is handled using Pratt parsing. Each operator has a "binding power" that determines how tightly it binds to its operands:

```rust
pub struct ParseRule {
    prefix: Option<fn(&mut Compiler)>,  // What to do if token starts an expression
    infix: Option<fn(&mut Compiler)>,   // What to do if token is between expressions
    precedence: Precedence
}
```

This allows the parser to naturally handle complex expressions like `2 * 3 + 1` by comparing precedence levels and parsing accordingly.

### Upvalue Management for Closures
Implementing closures required careful management of captured variables. When a function captures a variable from an enclosing scope, that variable becomes an "upvalue" - a reference that persists even after the original scope ends.

The VM tracks upvalues in a special table and ensures captured variables remain accessible even when their original scope is destroyed.

### Call Stack Management
Function calls require maintaining a call stack to track local variables, return addresses, and closure information. Each function call creates a new stack frame that's properly cleaned up when the function returns.

## Testing and Quality

The project includes comprehensive test coverage across all components

## Performance Considerations

While this is primarily an educational project, I've made several performance-conscious decisions:

- **Zero-copy string handling** where possible
- **Efficient bytecode representation** with variable-length instructions
- **Stack-based execution** for simple, fast operations
- **Proper memory management** with Rust's ownership system (yes, I didn't implement a proper garbage collector because Rust gave it out of the box)

## Lessons Learned

Building Elephant VM taught me several valuable lessons:

1. **Parsing is Hard**: Getting operator precedence right was more challenging than expected. Pratt parsing was a game-changer.

2. **Closures are Complex**: Implementing lexical scoping and closure capture required careful design of the upvalue system.

3. **Testing is Essential**: With so many interacting components, comprehensive tests were an integral part for catching edge cases.

4. **Rust's Type System Helps**: The compiler caught many potential bugs before they could become runtime issues.

5. **Documentation Matters**: As the codebase grew, good documentation became essential for maintaining the project.

## Future Enhancements

While Elephant VM is feature-complete for its intended scope, there are always improvements to consider:

- **Garbage Collection**: Currently uses reference counting, but a proper GC could improve performance
- **JIT Compilation**: Compile hot code paths to native machine code
- **Standard Library**: Add built-in functions for common operations
- **Debugger**: Interactive debugging capabilities
- **Module System**: Support for importing/exporting code

## Getting Started

You can try Elephant VM yourself:

```bash
# Clone the repository
git clone https://github.com/ermolushka/elephant-vm
cd elephant-vm

# Run a script
cargo run script.el

# Run a script with debug output
cargo run script.el --debug

# Interactive mode
cargo run

# Run tests
cargo test
```

## Conclusion

Building Elephant VM has been one of the most rewarding programming projects I've undertaken. It gave me deep insights into how programming languages work, from the low-level details of bytecode execution to the high-level concepts of lexical scoping and closures.

The project demonstrates that with careful design and implementation, you can build a surprisingly capable virtual machine in a relatively small amount of code. More importantly, it shows that understanding the fundamentals of computer science - parsing, compilation, and runtime systems - is not just academically interesting but practically valuable.

Whether you're interested in language design, virtual machines, or just want to understand how your favorite programming language works under the hood, I encourage you to explore the code and try building your own VM. The journey is as rewarding as the destination.

You can find the complete source code and documentation at [github.com/ermolushka/elephant-vm](https://github.com/ermolushka/elephant-vm).
