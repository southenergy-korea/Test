/**
 * KIRS(한국IR협의회) IPO IR 영상/IR Book 크롤링 스크립트
 * 
 * [설치]
 * npm install axios cheerio
 * 
 * [설정]
 * GAS_ENDPOINT와 KIRS_SECRET을 아래에 입력
 * 
 * [실행]
 * node update-kirs.js
 * 
 * [자동화] Windows 작업 스케줄러 또는 Mac launchd로 주 1~2회 실행 설정
 */

const axios  = require('axios');
const cheerio = require('cheerio');

// ===== 설정 =====
const GAS_ENDPOINT = process.env.GAS_URL || '';  // ← 이렇게 바꾸기
const KIRS_SECRET  = 'kirs-secret-2026';

const BASE_URL  = 'https://www.kirs.or.kr';
const LIST_URL  = 'https://www.kirs.or.kr/function.php';
const HEADERS   = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.kirs.or.kr/information/broadcast.html',
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/x-www-form-urlencoded'
};

// 회사명 정규화 (비교용)
function cleanName(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

// KIRS IPO IR 목록 가져오기 (최대 limit건)
async function fetchKirsList(limit = 200) {
  console.log(`KIRS IPO IR 목록 수집 중... (최대 ${limit}건)`);
  const params = new URLSearchParams({
    template: 'D100',
    action: 'media_search',
    keyword: '',
    cate: '1',   // 1 = IPO IR
    limit: String(limit)
  });
  const res = await axios.post(LIST_URL, params.toString(), { headers: HEADERS, timeout: 30000 });
  const $ = cheerio.load(res.data);

  const items = [];
  // 각 방송 항목 파싱
  $('a[href*="broadcastview.html"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const noM = href.match(/no=(\d+)/);
    if (!noM) return;
    const no = noM[1];
    // 제목 텍스트 (가장 가까운 dt 또는 link text)
    const title = $(el).text().trim() ||
                  $(el).closest('.mpl_con').find('dt').first().text().trim();
    if (!items.find(x => x.no === no)) {
      items.push({ no, title });
    }
  });

  console.log(`  목록 파싱 완료: ${items.length}건`);
  return items;
}

// 상세 페이지에서 YouTube + IR Book PDF 추출
async function fetchKirsDetail(no) {
  const url = `${BASE_URL}/information/broadcastview.html?no=${no}`;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
      timeout: 15000
    });
    const $ = cheerio.load(res.data);

    // 제목
    const title = $('#subject').text().trim();

    // YouTube URL
    let youtubeURL = '';
    const ytSrc = $('iframe[src*="youtube"]').attr('src') || '';
    const ytM = ytSrc.match(/embed\/([a-zA-Z0-9_-]+)/);
    if (ytM) youtubeURL = `https://www.youtube.com/watch?v=${ytM[1]}`;

    // IR Book PDF (attach_file 섹션)
    let irBookURL = '';
    $('.attach_file a[href$=".pdf"]').each((i, el) => {
      if (!irBookURL) irBookURL = $(el).attr('href') || '';
    });
    // fallback
    if (!irBookURL) {
      $('a[href$=".pdf"]').each((i, el) => {
        if (!irBookURL) irBookURL = $(el).attr('href') || '';
      });
    }

    return { title, youtubeURL, irBookURL, 방송URL: url };
  } catch (e) {
    console.error(`  상세 오류 (no=${no}): ${e.message}`);
    return null;
  }
}

// GAS 엔드포인트로 데이터 전송
async function sendToGas(items) {
  if (!items.length) { console.log('전송할 데이터 없음'); return; }
  console.log(`\nGAS로 ${items.length}건 전송 중...`);
  try {
    const res = await axios.post(GAS_ENDPOINT, JSON.stringify({
      secret: KIRS_SECRET,
      items
    }), {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
      maxRedirects: 5
    });
    const result = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    if (result.ok) {
      console.log(`✅ GAS 저장 완료: ${result.updated}건 매칭`);
    } else {
      console.error('❌ GAS 오류:', result.msg);
    }
  } catch (e) {
    console.error('GAS 전송 실패:', e.message);
  }
}

// ===== 메인 실행 =====
async function main() {
  console.log('=== KIRS IPO IR 크롤링 시작 ===\n');

  // 1. 목록 수집
  let listItems;
  try {
    listItems = await fetchKirsList(300);
  } catch (e) {
    console.error('목록 수집 실패:', e.message);
    process.exit(1);
  }

  if (!listItems.length) {
    console.log('수집된 항목 없음');
    process.exit(0);
  }

  // 2. 상세 페이지에서 YouTube + IR Book 수집
  const results = [];
  for (let i = 0; i < listItems.length; i++) {
    const item = listItems[i];
    process.stdout.write(`[${i+1}/${listItems.length}] ${item.title || 'no='+item.no} `);

    await new Promise(r => setTimeout(r, 400)); // 서버 부하 방지
    const detail = await fetchKirsDetail(item.no);

    if (detail && (detail.youtubeURL || detail.irBookURL)) {
      const name = detail.title || item.title;
      results.push({
        회사명: name.replace(/\s*IPO\s*IR\s*/i, '').replace(/\s*기업설명회\s*/i, '').trim(),
        youtubeURL: detail.youtubeURL,
        irBookURL:  detail.irBookURL,
        방송URL:    detail.방송URL
      });
      console.log(`✅ YT:${detail.youtubeURL ? '있음' : '없음'} PDF:${detail.irBookURL ? '있음' : '없음'}`);
    } else {
      console.log('⬜ 자료 없음');
    }
  }

  console.log(`\n수집 완료: ${results.length}건 (자료 있음)`);

  // 3. GAS로 전송
  await sendToGas(results);

  console.log('\n=== 완료 ===');
}

main().catch(console.error);
