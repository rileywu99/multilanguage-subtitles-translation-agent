// Demo mode (static GitHub Pages build, NEXT_PUBLIC_DEMO=1): there is no
// server and no API key, so the Translate step replays a prepared output for
// this one sample file. Detection still runs for real in the browser.
// The translations were written by hand to show what the pipeline produces
// (Taiwan vs mainland vocabulary, translated headers, glossary-consistent
// names) — they are not a recorded API response.

export const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

export const SAMPLE_FILE_NAME = "product-catalog-sample.csv";

export const SAMPLE_CSV = `sku,product_name,description,category,price_usd
SW-101,Photo Editing Software,Edit photos on your laptop with one-click filters and automatic cloud backup.,Desktop Software,49
HW-204,Wireless Mouse,Quiet clicks and a battery that lasts six months.,Computer Accessories,25
HW-310,USB-C Charging Cable,Fast charging for phones and tablets. One metre long.,Computer Accessories,12
SW-118,Video Calling App,HD video calls with screen sharing for up to 20 people.,Desktop Software,15
HW-402,Noise-Cancelling Headphones,Block out the subway and focus on your podcast.,Home Audio,129
HW-415,Portable Bluetooth Speaker,Waterproof speaker with 12 hours of playtime.,Home Audio,59
`;

type Prepared = {
  headers: string[];
  // product_name, description, category per sample row, in order
  rows: [string, string, string][];
  context: { domain: string; tone: string };
};

const CONTEXT = { domain: "consumer electronics & software catalog", tone: "concise retail copy" };

export const PREPARED: Record<string, Prepared> = {
  "zh-TW": {
    headers: ["商品編號", "商品名稱", "商品描述", "類別", "價格（美元）"],
    context: CONTEXT,
    rows: [
      ["修圖軟體", "在筆電上一鍵套用濾鏡修圖，還能自動雲端備份。", "電腦軟體"],
      ["無線滑鼠", "點擊聲安靜，電池可用六個月。", "電腦周邊"],
      ["USB-C 充電線", "手機、平板都能快速充電，長度 1 公尺。", "電腦周邊"],
      ["視訊通話 App", "高畫質視訊通話，可分享螢幕，最多 20 人同時上線。", "電腦軟體"],
      ["降噪耳機", "隔絕捷運噪音，專心聽你的 Podcast。", "居家音響"],
      ["可攜式藍牙喇叭", "防水喇叭，可連續播放 12 小時。", "居家音響"],
    ],
  },
  "zh-CN": {
    headers: ["商品编号", "商品名称", "商品描述", "类别", "价格（美元）"],
    context: CONTEXT,
    rows: [
      ["修图软件", "在笔记本电脑上一键套用滤镜修图，还能自动云备份。", "电脑软件"],
      ["无线鼠标", "点击声安静，电池续航六个月。", "电脑配件"],
      ["USB-C 充电线", "手机、平板都能快速充电，长 1 米。", "电脑配件"],
      ["视频通话应用", "高清视频通话，支持屏幕共享，最多 20 人同时在线。", "电脑软件"],
      ["降噪耳机", "隔绝地铁噪音，专心听你的播客。", "家庭音响"],
      ["便携式蓝牙音箱", "防水音箱，可连续播放 12 小时。", "家庭音响"],
    ],
  },
  ja: {
    headers: ["商品コード", "商品名", "説明", "カテゴリ", "価格（USD）"],
    context: CONTEXT,
    rows: [
      ["写真編集ソフト", "ワンクリックのフィルターと自動クラウドバックアップで、ノートパソコンから写真を編集。", "パソコンソフト"],
      ["ワイヤレスマウス", "静かなクリック音と、6か月もつバッテリー。", "パソコン周辺機器"],
      ["USB-C 充電ケーブル", "スマホやタブレットを急速充電。長さ 1 m。", "パソコン周辺機器"],
      ["ビデオ通話アプリ", "画面共有つきの HD ビデオ通話。最大 20 人まで参加可能。", "パソコンソフト"],
      ["ノイズキャンセリングヘッドホン", "地下鉄の騒音をシャットアウトして、ポッドキャストに集中。", "ホームオーディオ"],
      ["ポータブル Bluetooth スピーカー", "12 時間再生できる防水スピーカー。", "ホームオーディオ"],
    ],
  },
};

export const DEMO_STAGES = [
  "Analyzing domain and tone",
  "Building a name glossary",
  "Translating rows in parallel batches",
  "Validating every cell",
];
