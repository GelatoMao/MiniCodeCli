// @mini-code-cli/cli — ChatInput 输入缓冲区的原子状态 reducer
//
// 所有对输入缓冲区的修改都通过 `useReducer(inputReducer)` 进行，
// 确保单次按键同时修改文本和移动光标时作为一个状态转换提交（无中间帧）。
//
// Task 8 — 直接采用 x-code-cli 原实现。

export interface InputState {
  text: string
  cursor: number // 字符索引（非视觉列）
}

export type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string }
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number }
  | { type: 'DELETE'; pos: number }
  | { type: 'SET_CURSOR'; cursor: number }
  | { type: 'SET_TEXT'; text: string; cursor: number }
  | { type: 'RESET' }

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'INSERT': {
      const { pos, chunk } = action
      return {
        text: state.text.slice(0, pos) + chunk + state.text.slice(pos),
        cursor: pos + chunk.length,
      }
    }
    case 'BACKSPACE_REF': {
      const { pos, deleteCount } = action
      if (pos === 0) return state
      return {
        text: state.text.slice(0, pos - deleteCount) + state.text.slice(pos),
        cursor: pos - deleteCount,
      }
    }
    case 'DELETE': {
      const { pos } = action
      if (pos >= state.text.length) return state
      return { text: state.text.slice(0, pos) + state.text.slice(pos + 1), cursor: state.cursor }
    }
    case 'SET_CURSOR':
      return state.cursor === action.cursor ? state : { ...state, cursor: action.cursor }
    case 'SET_TEXT':
      return { text: action.text, cursor: action.cursor }
    case 'RESET':
      return { text: '', cursor: 0 }
    default:
      return state
  }
}
