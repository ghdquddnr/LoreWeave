# 서드파티 고지

LoreWeave(MIT)가 앱에 번들하는 글꼴이다. 세 글꼴 모두 SIL Open Font License 1.1이며, 아래 저작권 문구와 라이선스 원문을 함께 배포한다.
글꼴 파일은 npm 패키지 `@fontsource/*`(font-files 저장소의 Google Fonts 사본)에서 가져오고, 쓰는 굵기·문자 집합의 woff2만 `scripts/gen-fonts-css.mjs`가 `src/renderer/src/fonts.css`로 연결한다 (원격 주소 없음, `pnpm-lock.yaml`의 무결성 값으로 고정).

| 글꼴 | 패키지 | 번들하는 굵기 | 출처 |
|---|---|---|---|
| IBM Plex Sans KR | `@fontsource/ibm-plex-sans-kr` 5.3.0 | 400 · 500 · 600 | https://fontsource.org/fonts/ibm-plex-sans-kr |
| Noto Serif KR | `@fontsource/noto-serif-kr` 5.3.1 | 400 · 700 | https://fontsource.org/fonts/noto-serif-kr |
| JetBrains Mono (라틴만) | `@fontsource/jetbrains-mono` 5.3.0 | 400 · 500 | https://fontsource.org/fonts/jetbrains-mono, https://github.com/JetBrains/JetBrainsMono |

## 저작권 문구 (패키지의 LICENSE 첫 부분 그대로)

### IBM Plex Sans KR

```text
Copyright 2018 IBM Corp. All rights reserved. IBMPlexSansKR-ExtraLight.ttf: Copyright 2018 IBM Corp. All rights reserved. IBMPlexSansKR-Light.ttf: Copyright 2018 IBM Corp. All rights reserved. IBMPlexSansKR-Regular.ttf: Copyright 2018 IBM Corp. All rights reserved. IBMPlexSansKR-Medium.ttf: Copyright 2018 IBM Corp. All rights reserved. IBMPlexSansKR-SemiBold.ttf: Copyright 2018 IBM Corp. All rights reserved. IBMPlexSansKR-Bold.ttf: Copyright 2018 IBM Corp. All rights reserved.
```

### Noto Serif KR

```text
Google Inc.
```

### JetBrains Mono

```text
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
```

## SIL Open Font License 1.1 (세 패키지의 LICENSE 원문이 서로 같다)

```text
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
