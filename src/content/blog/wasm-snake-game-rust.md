---
author: Alexey Ermolaev
pubDatetime: 2025-01-22T21:44:00Z
modDatetime: 2025-01-22T21:44:00Z
title: Snake game in Rust + Webassembly
slug: wasm-snake-game-rust
featured: true
draft: false
tags:
  - rust
  - snake game
  - webassembly
  - wasm
  - javascript
  - js
  - html
description: Snake game written in Rust and compiled to Webassemly to run in your browser
---

I always wanted to play with WebAssembly and Rust ecosystem. Given, that I've seen different startups doing some advanced UI/Graphics in browser with the power of wasm, I decided to give it a try in my free time. The hardest part, of course, was to think of the project. As I didn't come up with something really interesting, then why not to try implementing [Snake game](<https://en.wikipedia.org/wiki/Snake_(video_game_genre)>) and play it within a browser?


## Setting up

Of course, you need Rust, rustc etc and I assume you already have it, otherwise, check out how to set it up. Then, you will need `wasm-pack` - tool for building, testing and publishing Rust-generated WebAssembly. You can dowload it [here](https://rustwasm.github.io/wasm-pack/installer/).

Next, you will need `cargo-generate` to be able to use some git repos as a new Rust porject template.

```rust
cargo install cargo-generate
```

Finally, as we will need to write a js logic to run in the browser, you will need `npm`, assuming it's installed, good idea to update it (if you wish).

```
npm install npm@latest -g
```

## Rust logic

I used `wasm-pack-template` to start with and renamed it with `wasm-snake`

```
cargo generate --git https://github.com/rustwasm/wasm-pack-template
```

Ok, now let's look what we need to add in `lib.rs`

First of all, we have a grid with cells and each cell is either empty (snake is not there) or filled (snake is there or in this cell there is a goal/food which snake needs to get to)

```
#[wasm_bindgen]
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cell {
    Empty = 0,
    Filled = 1,
}
```
`wasm_bindgen` here is to interface with js.


We also have directions, universe itself (grid) and snake which has direction, body (as a 1d-array of indexes of grid) and liveness status
```
#[wasm_bindgen]
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Left = 0,
    Right = 1,
    Up = 2,
    Down = 3,
}

#[wasm_bindgen]
pub struct Universe {
    width: u32,
    height: u32,
    cells: Vec<Cell>,
    snake: Snake,
    target: u32,
}

#[wasm_bindgen]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snake {
    direction: Direction,
    body: Vec<u32>,
    alive: bool,
}
```

It would be not resource-efficient to store tuples of coordinates, that's why there are methods to convert coordinates back-and-forth

```
fn get_index(&self, row: u32, column: u32) -> usize {
        (row * self.width + column) as usize
}

pub fn get_row_col(&self, index: usize, width: u32) -> (u32, u32) {
        let row = (index as u32) / width;
        let col = (index as u32) % width;
        (row, col)
}
```

Then, we need logic to calculate snake's next move and check if it's ok

```
pub fn get_next_move(&mut self, width: u32) -> (u32, u32) {
        match self.body.last() {
            Some(val) => {
                let (row, col) = self.get_row_col(*val as usize, width);

                match self.direction {
                    Direction::Up => {
                        if row == 0 {
                            self.alive = false;
                            return (row, col);
                        }
                        (row - 1, col)
                    }
                    Direction::Down => {
                        if row >= width - 1 {
                            // Using width since it's a square grid
                            self.alive = false;
                            return (row, col);
                        }
                        (row + 1, col)
                    }
                    Direction::Left => {
                        if col == 0 {
                            self.alive = false;
                            return (row, col);
                        }
                        (row, col - 1)
                    }
                    Direction::Right => {
                        if col >= width - 1 {
                            self.alive = false;
                            return (row, col);
                        }
                        (row, col + 1)
                    }
                }
            }
            None => panic!("snake body is empty"),
        }
    }
```

I will not cover the whole logic as you can find it [here](https://github.com/ermolushka/wasm-snake/blob/main/src/lib.rs) but important thing:

If you want to expose any function to be called from js, you need to use `#[wasm_bindgen]` macro.

Once logic is ready, you cna run `wasm-pack build` which will generate `.wasm` file.


## UI logic

For UI, I also used https://github.com/rustwasm/create-wasm-app template.

Within you project's root folder run

```
npm init wasm-app www
npm install
```

Then, open `www/package.json` and add to `dependencies`

```
"dependencies": {
    "wasm-snake": "file:../pkg", // Add this line, change the project name to yours
    // ...
  }
```

Then again

```
npm install
```

What have I added to the js logic:

index.js

```
import { Universe, Cell, Direction } from "wasm-snake";
import { memory } from "wasm-snake/wasm_snake_bg";


const CELL_SIZE = 8; // px
const GRID_COLOR = "#CCCCCC";
const DEAD_COLOR = "#FFFFFF";
const ALIVE_COLOR = "#000000";

// Construct the universe, and get its width and height.
const universe = Universe.new();
const width = universe.width();
const height = universe.height();

// Give the canvas room for all of our cells and a 1px border
// around each of them.
const canvas = document.getElementById("snake-canvas");
canvas.height = (CELL_SIZE + 1) * height + 1;
canvas.width = (CELL_SIZE + 1) * width + 1;

const ctx = canvas.getContext('2d');

let animationId = null;


let currentDirection = Direction.Right; // Default direction

document.addEventListener('keydown', event => {
  if(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
  }

  const prevDirection = currentDirection;
  
  switch (event.key) {
    case 'ArrowUp':
      if (currentDirection !== Direction.Down && prevDirection !== Direction.Down) {
        currentDirection = Direction.Up;
        universe.change_snake_direction(Direction.Up);
      }
      break;
    case 'ArrowRight':
      if (currentDirection !== Direction.Left && prevDirection !== Direction.Left) {
        currentDirection = Direction.Right;
        universe.change_snake_direction(Direction.Right);
      }
      break;
    case 'ArrowDown':
      if (currentDirection !== Direction.Up && prevDirection !== Direction.Up) {
        currentDirection = Direction.Down;
        universe.change_snake_direction(Direction.Down);
      }
      break;
    case 'ArrowLeft':
      if (currentDirection !== Direction.Right && prevDirection !== Direction.Right) {
        currentDirection = Direction.Left;
        universe.change_snake_direction(Direction.Left);
      }
      break;
  }
});

const renderLoop = () => {
  drawGrid();
  drawCells();

  universe.tick();
  if (universe.snake_is_alive()) {
    animationId = setTimeout(renderLoop, 500);
  } else {
    gameStatus.textContent = "game over"
    pause();
  }
};

const gameStatus = document.getElementById("game-status");

const play = () => {
  gameStatus.textContent = "playing"
  renderLoop();
};

const pause = () => {
  cancelAnimationFrame(animationId);
  animationId = null;
};

const drawGrid = () => {
    ctx.beginPath();
    ctx.strokeStyle = GRID_COLOR;
  
    // Vertical lines.
    for (let i = 0; i <= width; i++) {
      ctx.moveTo(i * (CELL_SIZE + 1) + 1, 0);
      ctx.lineTo(i * (CELL_SIZE + 1) + 1, (CELL_SIZE + 1) * height + 1);
    }
  
    // Horizontal lines.
    for (let j = 0; j <= height; j++) {
      ctx.moveTo(0,                           j * (CELL_SIZE + 1) + 1);
      ctx.lineTo((CELL_SIZE + 1) * width + 1, j * (CELL_SIZE + 1) + 1);
    }
  
    ctx.stroke();
  };

  const getIndex = (row, column) => {
    return row * width + column;
  };
  
  const drawCells = () => {
    const cellsPtr = universe.cells();
    const cells = new Uint8Array(memory.buffer, cellsPtr, width * height);
  
    ctx.beginPath();
  
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = getIndex(row, col);
  
        ctx.fillStyle = cells[idx] === Cell.Empty
          ? DEAD_COLOR
          : ALIVE_COLOR;
  
        ctx.fillRect(
          col * (CELL_SIZE + 1) + 1,
          row * (CELL_SIZE + 1) + 1,
          CELL_SIZE,
          CELL_SIZE
        );
      }
    }
  
    ctx.stroke();
  };

drawGrid();
drawCells();
play();
```

The main logic for drawing cells, grid, calling .wasm, checking snake status and stop the game if it's dead.

And some basic html

index.html

```
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Snake Game</title>
    <style>
      body {
        margin: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        background-color: #f0f2f5;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        overflow: hidden;
      }

      #game-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.5rem;
        padding: 2rem;
        background-color: white;
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      }

      #game-header {
        text-align: center;
      }

      #game-title {
        font-size: 2rem;
        color: #1a1a1a;
        margin: 0;
        margin-bottom: 0.5rem;
      }

      #game-status {
        font-size: 1.2rem;
        color: #666;
        margin: 0;
      }

      #snake-canvas {
        border: 2px solid #e0e0e0;
        border-radius: 4px;
        background-color: white;
      }

      #controls {
        margin-top: 1rem;
        text-align: center;
        color: #666;
      }

      .key-instruction {
        display: inline-block;
        padding: 0.5rem 1rem;
        margin: 0.25rem;
        background-color: #f8f9fa;
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        font-size: 0.9rem;
      }

      @media (max-width: 600px) {
        #game-container {
          padding: 1rem;
        }

        #game-title {
          font-size: 1.5rem;
        }

        .key-instruction {
          padding: 0.25rem 0.5rem;
          font-size: 0.8rem;
        }
      }
    </style>
  </head>
  <body>
    <div id="game-container">
      <div id="game-header">
        <h1 id="game-title">Snake Game</h1>
        <h3 id="game-status">Use arrow keys to play</h3>
      </div>
      <canvas id="snake-canvas"></canvas>
      <div id="controls">
        <div class="key-instruction">↑ Up</div>
        <div class="key-instruction">↓ Down</div>
        <div class="key-instruction">← Left</div>
        <div class="key-instruction">→ Right</div>
      </div>
    </div>
    <script src='./bootstrap.js'></script>
  </body>
</html>
```

The result looks like this

![Final result](@assets/images/snake-wasm.png)

Hopefully, it was helpful for anyone, feel free to use my logic as a starting point for yourself.

