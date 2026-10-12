// 글 만들기(src/content)를 끼우는 한 곳. 처리기는 여기서만 그 폴더를 안다.
// 처리기가 쓰는 것: 두 언어 글 만들기, 용어집 줄 고르기, (글 작업이 죽었을 때의) 틀 문장.
import type { ContentApi } from '@/contract/content';
import content from '@/content';

export const contentApi: (Pick<ContentApi, 'generateContent' | 'pickGlossary'> & Partial<Pick<ContentApi, 'templateTexts'>>) | undefined = content;
