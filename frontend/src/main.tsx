import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/roboto-mono/latin-400.css'
import '@fontsource/roboto-mono/latin-500.css'
import './styles/app.css'
import { render } from 'preact'
import { App } from './App'

render(<App />, document.getElementById('root')!)
