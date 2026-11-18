// Luau (Roblox Lua) for Monaco: tokenizer with the Roblox and executor globals, snippets, indentation rules, and the Flux theme.
// Language and snippets are taken from the aotr-hub editor.
function registerLuau(M) {
M.languages.register({id:'luau'});
 M.languages.setLanguageConfiguration('luau',{comments:{lineComment:'--',blockComment:['--[[',']]']},brackets:[['{','}'],['[',']'],['(',')']],
  autoClosingPairs:[{open:'{',close:'}'},{open:'[',close:']'},{open:'(',close:')'},{open:'"',close:'"',notIn:['string']},{open:"'",close:"'",notIn:['string']}],
  surroundingPairs:[{open:'{',close:'}'},{open:'[',close:']'},{open:'(',close:')'},{open:'"',close:'"'},{open:"'",close:"'"}],
  indentationRules:{increaseIndentPattern:/^\s*(function|local\s+function|if|for|while|repeat|else|elseif|do)\b.*$|.*\b(then|do)\s*$|.*\{\s*$/,decreaseIndentPattern:/^\s*(end|else|elseif|until|\}|\))/}});
 M.languages.setMonarchTokensProvider('luau',{defaultToken:'',
  keywords:['and','break','do','else','elseif','end','false','for','function','goto','if','in','local','nil','not','or','repeat','return','then','true','until','while','continue'],
  builtins:['print','warn','error','assert','pcall','xpcall','select','tostring','tonumber','type','typeof','pairs','ipairs','next','rawget','rawset','rawequal','setmetatable','getmetatable','require','loadstring','game','workspace','script','task','wait','spawn','delay','tick','time','os','string','table','math','coroutine','bit32','utf8','Instance','Vector2','Vector3','CFrame','Color3','BrickColor','UDim','UDim2','Enum','Ray','TweenInfo','getgenv','getrenv','getfenv','setfenv','getgc','getinstances','readfile','writefile','appendfile','isfile','isfolder','makefolder','listfiles','delfile','hookfunction','hookmetamethod','newcclosure','checkcaller','firesignal','fireclickdetector','fireproximityprompt','firetouchinterest','request','http_request','identifyexecutor','setclipboard','Drawing','cloneref','gethui'],
  tokenizer:{root:[[/--\[\[/,'comment','@block'],[/--.*$/,'comment'],[/\[\[/,'string','@long'],[/"/,'string','@dq'],[/'/,'string','@sq'],
   [/0[xX][0-9a-fA-F]+/,'number.hex'],[/\d+(\.\d+)?([eE][\-+]?\d+)?/,'number'],
   [/[a-zA-Z_]\w*/,{cases:{'@keywords':'keyword','@builtins':'type.identifier','@default':'identifier'}}],
   [/[{}()\[\]]/,'@brackets'],[/[=+\-*\/%^#<>~.:,;]+/,'operator']],
   block:[[/[^\]]+/,'comment'],[/\]\]/,'comment','@pop'],[/\]/,'comment']],
   long:[[/[^\]]+/,'string'],[/\]\]/,'string','@pop'],[/\]/,'string']],
   dq:[[/[^\\"]+/,'string'],[/\\./,'string.escape'],[/"/,'string','@pop']],
   sq:[[/[^\\']+/,'string'],[/\\./,'string.escape'],[/'/,'string','@pop']]}});
 const sn=(label,body,doc)=>({label,kind:M.languages.CompletionItemKind.Snippet,insertText:body,insertTextRules:M.languages.CompletionItemInsertTextRule.InsertAsSnippet,documentation:doc||''});
 const SN=[sn('game:GetService','game:GetService("${1:Players}")'),sn('LocalPlayer','game:GetService("Players").LocalPlayer'),sn('task.wait','task.wait(${1:1})'),
  sn('task.spawn','task.spawn(function()\n\t$0\nend)'),sn('for ipairs','for _, ${1:v} in ipairs(${2:t}) do\n\t$0\nend'),sn('for pairs','for ${1:k}, ${2:v} in pairs(${3:t}) do\n\t$0\nend'),
  sn('function','function ${1:name}(${2})\n\t$0\nend'),sn('local function','local function ${1:name}(${2})\n\t$0\nend'),sn('if','if ${1:cond} then\n\t$0\nend'),
  sn('while true','while true do\n\t$0\n\ttask.wait()\nend'),sn('pcall','pcall(function()\n\t$0\nend)'),sn('loadstring HttpGet','loadstring(game:HttpGet("${1:url}"))()'),
  sn('Instance.new','Instance.new("${1:Part}")'),sn('FindFirstChild','${1:parent}:FindFirstChild("${2:Name}")'),sn('Vector3.new','Vector3.new(${1:0}, ${2:0}, ${3:0})'),
  sn('CFrame.new','CFrame.new(${1:0}, ${2:0}, ${3:0})'),sn('Character','game:GetService("Players").LocalPlayer.Character'),sn('getgenv','getgenv().${1:name}'),sn('print','print(${1})'),sn('warn','warn(${1})')];
 M.languages.registerCompletionItemProvider('luau',{triggerCharacters:['.',':'],provideCompletionItems:(model,pos)=>{const w=model.getWordUntilPosition(pos),range={startLineNumber:pos.lineNumber,endLineNumber:pos.lineNumber,startColumn:w.startColumn,endColumn:w.endColumn};
  return{suggestions:SN.map(x=>({...x,range}))}}});

  M.editor.defineTheme('flux', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c4b5fd' }, { token: 'string', foreground: 'a7f3d0' }, { token: 'string.escape', foreground: '6ee7b7' },
      { token: 'number', foreground: 'fcd34d' }, { token: 'number.hex', foreground: 'fcd34d' }, { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'type.identifier', foreground: '93c5fd' }, { token: 'identifier', foreground: 'e6e6ea' }, { token: 'operator', foreground: '9ca3af' },
    ],
    colors: {
      'editor.background': '#00000000', 'editor.foreground': '#e6e6ea', 'editorGutter.background': '#00000000', 'editorLineNumber.foreground': '#4b4b57', 'editorLineNumber.activeForeground': '#c9c9d3',
      'editor.lineHighlightBackground': '#ffffff09', 'editor.lineHighlightBorder': '#00000000', 'editorCursor.foreground': '#ffffff', 'editor.selectionBackground': '#ffffff2b', 'editor.inactiveSelectionBackground': '#ffffff15',
      'editorIndentGuide.background1': '#ffffff10', 'editorIndentGuide.activeBackground1': '#ffffff28', 'scrollbarSlider.background': '#ffffff18', 'scrollbarSlider.hoverBackground': '#ffffff2a', 'scrollbarSlider.activeBackground': '#ffffff3a',
      'focusBorder': '#00000000', 'editorBracketMatch.background': '#ffffff1a', 'editorBracketMatch.border': '#ffffff33',
      'editorWidget.background': '#101015', 'editorWidget.border': '#ffffff1a', 'editorSuggestWidget.background': '#101015', 'editorSuggestWidget.border': '#ffffff1a',
      'editorSuggestWidget.selectedBackground': '#ffffff14', 'editorSuggestWidget.highlightForeground': '#c4b5fd', 'editorHoverWidget.background': '#101015', 'editorHoverWidget.border': '#ffffff1a',
    },
  });
}
