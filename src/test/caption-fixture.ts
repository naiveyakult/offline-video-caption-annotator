export const captionFixture = {
  _id: "fixture-1",
  video_path: "clips/fixture-1.mp4",
  caption_en: `## Overview

Overall Visual Style:
Cinematic natural light.

Overall Audio Style:
Quiet forest ambience.

Character Profiles:
Alice - A calm woman.
Bob - A tired man.

Narrative Theme:
Patience and trust.

## Storyline

00:00.000 - 00:05.000
Alice watches Bob and says, "Wait here."

00:05.000 - 00:10.000
Bob sits beside the road.

## Speech Transcript

00:01.000 - 00:02.000
Speaker: Alice
State: calm
Content: "Wait here."

00:07.000 - 00:08.000
Speaker: Bob
State: tired
Content: "All right."

## Visible Text

00:03.000 - 00:04.000
"WAIT\\nHERE": white text`,
  caption_zh: `## 概览

整体视觉风格：
电影化的自然光。

整体音频风格：
安静的森林环境声。

人物档案：
Alice——一名平静的女性。
Bob——一名疲惫的男性。

叙事主题：
耐心与信任。

## 故事线

00:00.000 - 00:05.000
Alice 注视着 Bob 并说道，"Wait here."

00:05.000 - 00:10.000
Bob 坐在路边。

## 语音转录

00:01.000 - 00:02.000
说话人：Alice
状态：平静
内容："Wait here."

00:07.000 - 00:08.000
说话人：Bob
状态：疲惫
内容："All right."

## 可见文字

00:03.000 - 00:04.000
"WAIT\\nHERE"：白色文字`,
  usage: { total_tokens: 100 },
};

export const noSpeechFixture = {
  ...captionFixture,
  caption_en: captionFixture.caption_en.replace(
    /## Speech Transcript[\s\S]*?## Visible Text/,
    "## Speech Transcript\n\nNo audible speech is present in the video.\n\n## Visible Text",
  ),
  caption_zh: captionFixture.caption_zh.replace(
    /## 语音转录[\s\S]*?## 可见文字/,
    "## 语音转录\n\n视频中没有可闻的语音。\n\n## 可见文字",
  ),
};
