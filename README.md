# job-hunting

個人開発置き場。

## universe/

言葉のない宇宙。あなたは一点の光。

- 公開: https://uchu.pages.dev （複数端末で互いの光が見える）
- 構成: 静的ファイル（`public/`）をCloudflare Pagesで配信 + リアルタイム同期は Worker + Durable Object（`src/worker.ts`）
- WS接続先: `universe.taroooo0w0.workers.dev/ws`
- ローカル確認: `npx serve universe/public`
- デプロイ: `cd universe && npx wrangler pages deploy public --project-name uchu`（Worker側を変えた時は `npx wrangler deploy`）

## todo/

（保留）「消えるTODO」のアイデア用scaffold。日付が変わるとタスクが消えるコンセプト。
