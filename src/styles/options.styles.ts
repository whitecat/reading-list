import { css } from 'lit';

export const styles = css`
  :host {
    display: block;
    padding: 2em;
    background: var(--rl-page-bg-color);
    color: var(--rl-text-color);
    font-family: var(--base-font);
  }

  .section {
    margin-bottom: 2em;
  }

  .option {
    margin-bottom: 1.5em;
    display: flex;
    align-items: center;
    gap: 1em;
  }

  input[type='checkbox'] {
    width: 1.2em;
    height: 1.2em;
    cursor: pointer;
  }

  label {
    cursor: pointer;
    font-size: 1em;
  }

  button {
    padding: 0.5em 1em;
    font-size: 1em;
    margin-top: 1em;
    background: var(--primary-color);
    color: var(--rl-on-accent-color);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  button:hover {
    background: var(--primary-color-focus);
  }

  button.danger {
    background: var(--rl-danger-color);
  }

  button.danger:hover {
    background: var(--rl-danger-color-hover);
  }

  details {
    margin-top: 1em;
  }

  summary {
    cursor: pointer;
    font-weight: bold;
  }

  details > div {
    margin-top: 1em;
  }

  .hint {
    font-size: 0.85em;
    opacity: 0.8;
  }

  table.storage {
    border-collapse: collapse;
  }

  table.storage th {
    font-weight: normal;
    font-size: 0.85em;
    text-align: left;
    padding-right: 1em;
  }

  table.storage td {
    padding: 0.5em 1em 0.5em 0;
    vertical-align: top;
  }

  input[type='radio'] {
    width: 1.2em;
    height: 1.2em;
    cursor: pointer;
  }

  .api-fields {
    display: flex;
    flex-direction: column;
    gap: 0.75em;
    max-width: 30em;
    margin-top: 0.5em;
  }

  .api-fields label {
    display: flex;
    flex-direction: column;
    gap: 0.25em;
    cursor: default;
  }

  .api-fields input {
    padding: 0.4em;
    font-size: 1em;
    border: 1px solid var(--rl-border-color);
    border-radius: 4px;
    background: var(--rl-bg-color);
    color: var(--rl-text-color);
  }

  .status {
    white-space: pre-wrap;
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .diagnostics pre {
    margin-top: 1em;
    padding: 1em;
    border: 1px solid var(--rl-border-color);
    border-radius: 4px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.85em;
    user-select: text;
  }

  @media (prefers-color-scheme: dark) {
    button {
      background: var(--rl-bg-color);
      color: var(--rl-text-color);
    }

    button:hover {
      background: var(--rl-hover-bg-color);
    }
  }
`;
