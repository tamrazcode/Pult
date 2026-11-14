//! Agent drivers. `acp` is the universal driver (§4.4); native drivers come later.

pub mod acp;

#[cfg(test)]
mod golden;
