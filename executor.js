name: Aave Liquidation Bot — Ultra

on:
  schedule:
    - cron: '*/15 * * * *'
    - cron: '0 */4 * * *'
  workflow_dispatch:

permissions:
  contents: write

jobs:

  liquidate:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' || github.event.schedule == '*/15 * * * *'
    env:
      RPC_URL:        ${{ secrets.RPC_URL }}
      GRAPH_API_KEY:  ${{ secrets.GRAPH_API_KEY }}
      PRIVATE_KEY:    ${{ secrets.PRIVATE_KEY }}
      WALLET_ADDRESS: ${{ secrets.WALLET_ADDRESS }}

    steps:
      - name: Checkout
        uses: actions/checkout@v3

      - name: Setup Node 16
        uses: actions/setup-node@v3
        with:
          node-version: '16'

      - name: Install dependencies
        run: npm install ethers@5.7.2 axios

      - name: Run Executor
        run: node executor.js
        timeout-minutes: 10

  refresh-whales:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' || github.event.schedule == '0 */4 * * *'
    env:
      RPC_URL:        ${{ secrets.RPC_URL }}
      GRAPH_API_KEY:  ${{ secrets.GRAPH_API_KEY }}
      PRIVATE_KEY:    ${{ secrets.PRIVATE_KEY }}
      WALLET_ADDRESS: ${{ secrets.WALLET_ADDRESS }}

    steps:
      - name: Checkout
        uses: actions/checkout@v3

      - name: Setup Node 16
        uses: actions/setup-node@v3
        with:
          node-version: '16'

      - name: Install dependencies
        run: npm install ethers@5.7.2 axios

      - name: Refresh Whale List
        run: node findWhales.js
        timeout-minutes: 25

      - name: Commit updated whales.json
        run: |
          git config user.email "bot@liquidation.com"
          git config user.name "Liquidation Bot"
          git add whales.json
          git diff --staged --quiet || git commit -m "🐋 Auto: Whale list refreshed $(date -u '+%Y-%m-%d %H:%M UTC')"
          git push
